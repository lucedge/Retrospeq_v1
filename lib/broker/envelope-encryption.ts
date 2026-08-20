import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for broker credentials — 00-foundation §4.1:
 *
 *   plaintext credential
 *     -> encrypted with a per-credential data key (AES-256-GCM)
 *     -> data key encrypted with a master key held in an external KMS
 *     -> ciphertext + wrapped data key + IV + auth tag stored in Postgres
 *
 * `account_credentials` (supabase/migrations/20260820040000_trading_accounts.sql)
 * stores exactly these four fields plus `kms_key_id` naming which master
 * key wrapped the data key. This module never talks to Postgres itself —
 * callers (the connect flow, `lib/broker/connect.ts`) persist the
 * `EncryptedCredential` this produces.
 *
 * AGENTS.md's security bar, verbatim: "A single static app-wide
 * encryption key ... does not meet this bar — do not reintroduce that
 * pattern." There is deliberately no code path in this file that can
 * produce a working `MasterKeyProvider` without a real external KMS
 * configured — see `createKmsMasterKeyProvider` below, which throws
 * `KmsNotConfiguredError` unconditionally until a KMS vendor is chosen
 * (PROGRESS.md "Infra gaps": no external KMS account yet).
 */

const DATA_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit IV, the GCM standard/recommended size
const ALGORITHM = 'aes-256-gcm';

/** Everything `account_credentials` stores for one credential, per the
 *  migration's column shape. Buffers map 1:1 onto `bytea` columns. */
export interface EncryptedCredential {
  ciphertext: Buffer;
  wrappedDek: Buffer;
  iv: Buffer;
  authTag: Buffer;
  kmsKeyId: string;
}

/**
 * The KMS wrap/unwrap boundary. Deliberately an interface, not a
 * concrete implementation tied to one vendor (AWS KMS / GCP Cloud KMS /
 * etc) — 00-foundation §10's vendor-agnosticism principle applies to the
 * KMS the same way it applies to `BrokerAdapter`. A real implementation
 * calls out to the external KMS's own wrap/unwrap (or
 * generate-data-key/decrypt) API; the master key itself never enters
 * this process's memory as a Node `Buffer` a real production
 * implementation would hold onto — it stays inside the KMS.
 */
export interface MasterKeyProvider {
  /** Wraps (encrypts) a per-credential data key using the external KMS
   *  master key. Returns the wrapped bytes plus which key id did the
   *  wrapping (stored as `account_credentials.kms_key_id`). */
  wrapDataKey(dataKey: Buffer): Promise<{ wrappedDek: Buffer; kmsKeyId: string }>;
  /** Unwraps (decrypts) a previously wrapped data key, given the key id
   *  it claims to have been wrapped under. */
  unwrapDataKey(wrappedDek: Buffer, kmsKeyId: string): Promise<Buffer>;
}

/**
 * Thrown by `createKmsMasterKeyProvider` — never a fallback to a local
 * or static key. AGENTS.md: "if a real dependency is missing ... do not
 * simulate success ... write it to fail loudly and clearly when that
 * dependency is absent (a thrown error naming exactly what's missing)."
 */
export class KmsNotConfiguredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `External KMS is not configured — missing: ${missing.join(', ')}. ` +
        'Envelope encryption (00-foundation §4.1) requires a real external ' +
        'KMS master key; this project has none yet (see PROGRESS.md "Infra ' +
        'gaps"). Refusing to fall back to an application-held key — a single ' +
        "static app-wide encryption key does not meet this project's " +
        'security bar (AGENTS.md "Broker credentials").',
    );
    this.name = 'KmsNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Production `MasterKeyProvider` factory. Always throws today —
 * TODO(kms): once an external KMS vendor and account exist (PROGRESS.md
 * "Infra gaps"), replace this function's body with real wrap/unwrap
 * calls (e.g. AWS KMS `Encrypt`/`Decrypt`, GCP Cloud KMS
 * `encrypt`/`decrypt`) keyed on `RETROSPEQ_KMS_KEY_ID` and whatever SDK
 * credentials that vendor requires. Until then there is no vendor SDK
 * this function could call even if every env var below were set, so it
 * fails loudly and unconditionally rather than silently no-op'ing or
 * standing in a fake key — do not "fix" this by making it succeed
 * without a real KMS behind it.
 */
export function createKmsMasterKeyProvider(): MasterKeyProvider {
  const missing: string[] = [];
  if (!process.env.RETROSPEQ_KMS_KEY_ID) missing.push('RETROSPEQ_KMS_KEY_ID');
  missing.push(
    'a wired-in external KMS vendor SDK (none chosen yet — see TODO(kms) in this file)',
  );
  throw new KmsNotConfiguredError(missing);
}

/**
 * plaintext -> per-credential AES-256-GCM data key -> wrapped by the
 * master key. The plaintext data key is zeroed in memory as soon as it
 * has been wrapped (defence in depth — Node's GC does not guarantee
 * prompt buffer clearing, but this removes the value from the one
 * reference this function held).
 */
export async function encryptCredential(
  plaintext: string,
  masterKeyProvider: MasterKeyProvider,
): Promise<EncryptedCredential> {
  const dek = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  try {
    const { wrappedDek, kmsKeyId } = await masterKeyProvider.wrapDataKey(dek);
    return { ciphertext, wrappedDek, iv, authTag, kmsKeyId };
  } finally {
    dek.fill(0);
  }
}

/**
 * Reverses `encryptCredential`. Throws if the auth tag does not verify
 * (tamper detection — a flipped ciphertext or auth-tag byte fails here,
 * not silently returns garbage) or if the master key provider rejects
 * the wrapped key (e.g. wrong `kmsKeyId`, revoked key).
 */
export async function decryptCredential(
  record: EncryptedCredential,
  masterKeyProvider: MasterKeyProvider,
): Promise<string> {
  const dek = await masterKeyProvider.unwrapDataKey(record.wrappedDek, record.kmsKeyId);
  try {
    const decipher = createDecipheriv(ALGORITHM, dek, record.iv);
    decipher.setAuthTag(record.authTag);
    const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } finally {
    dek.fill(0);
  }
}
