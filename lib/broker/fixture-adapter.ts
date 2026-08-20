import 'server-only';
import type {
  AccountHandle,
  BrokerAdapter,
  BrokerCredentialInput,
  Fill,
  Position,
  PositionSnap,
  TierFlags,
} from './adapter';
import {
  BrokerAuthFailedError,
  BrokerCredentialTooPermissiveError,
  BrokerServerUnknownError,
  BrokerVendorUnavailableError,
} from './adapter';

/**
 * FIXTURE / TEST-ONLY BrokerAdapter — never a real broker.
 *
 * No broker integration vendor exists yet (PROGRESS.md "Infra gaps" /
 * 00-foundation §10.1: "vendor is deliberately unspecified"). This
 * adapter is a deterministic, in-memory implementation of the
 * `BrokerAdapter` interface used for unit/integration tests and, once a
 * later slice builds the UI, an explicitly-labelled dev/demo path only
 * — it must never be wired into a real user's connect flow as if it
 * were a live broker (AGENTS.md "When something needs the owner — never
 * fake it, always flag it"). Nothing in this file talks to a network.
 *
 * `import 'server-only'` mirrors `lib/supabase/service.ts`'s guard: this
 * module simulates handling credential material end-to-end (including
 * the master-credential-rejection path) and must never end up in a
 * client bundle, even as a fixture. Tests mock `server-only` the same
 * way `lib/supabase/__tests__/service.test.ts` does.
 *
 * `createFixtureBrokerAdapter` takes an explicit `behavior` so a caller
 * (a test, or the future dev/demo path) must consciously choose which
 * scenario it's exercising — there is no silent "always succeeds"
 * default that could be mistaken for real connectivity. The default
 * (`'connect_ok'`) is still explicit in the return type/config so a
 * reader can see it was chosen, not assumed.
 */

export type FixtureAdapterBehavior =
  | 'connect_ok'
  | 'auth_failed'
  | 'credential_too_permissive'
  | 'server_unknown'
  | 'vendor_unavailable';

export interface FixtureAdapterConfig {
  /** Which scenario this adapter instance simulates. Required — see
   *  header comment on why there is no implicit default export. */
  behavior: FixtureAdapterBehavior;
  /** Sync tier reported by `capabilities()` when `behavior === 'connect_ok'`. */
  tier?: TierFlags;
  /** Fixed fill history returned by `fetchHistory`. */
  fills?: Fill[];
  /** Fixed open positions returned by `fetchOpenPositions`. */
  openPositions?: Position[];
  /** Fixed T1 snapshots returned by `snapshotPositions`. */
  positionSnaps?: PositionSnap[];
  /** Broker-side account id to report on the handle. */
  providerAccountRef?: string;
}

const DEFAULT_TIER: TierFlags = {
  tier: 't0',
  history: true,
  openPositions: true,
  positionSnapshots: false,
  liveSession: false,
};

/** Fixture handles are branded so `fetchHistory`/etc can assert they were
 *  issued by this same fixture instance and not, say, a stray real
 *  adapter's handle passed in by mistake. */
interface FixtureAccountHandle extends AccountHandle {
  readonly adapterId: 'fixture';
}

function isFixtureHandle(handle: AccountHandle): handle is FixtureAccountHandle {
  return handle.adapterId === 'fixture';
}

export function createFixtureBrokerAdapter(config: FixtureAdapterConfig): BrokerAdapter {
  const {
    behavior,
    tier = DEFAULT_TIER,
    fills = [],
    openPositions = [],
    positionSnaps = [],
    providerAccountRef = 'fixture-account-1',
  } = config;

  function requireFixtureHandle(handle: AccountHandle): asserts handle is FixtureAccountHandle {
    if (!isFixtureHandle(handle)) {
      throw new Error(
        'createFixtureBrokerAdapter: handle was not issued by this fixture adapter instance.',
      );
    }
  }

  return {
    async connect(_credential: BrokerCredentialInput): Promise<AccountHandle> {
      switch (behavior) {
        case 'connect_ok':
          return {
            adapterId: 'fixture',
            providerAccountRef,
            verifiedReadonly: true,
          } satisfies FixtureAccountHandle;
        case 'auth_failed':
          throw new BrokerAuthFailedError('fixture: simulated bad login/password/server.');
        case 'credential_too_permissive':
          // MANDATORY rejection path (Module 01 §4.1 step 4). Never
          // include the credential value in this error — the type
          // signature above never accepts it in the first place.
          throw new BrokerCredentialTooPermissiveError(
            'fixture: simulated master-credential (trade-capable) rejection.',
          );
        case 'server_unknown':
          throw new BrokerServerUnknownError('fixture: simulated unresolvable server.');
        case 'vendor_unavailable':
          throw new BrokerVendorUnavailableError('fixture: simulated vendor outage.');
        default: {
          const exhaustive: never = behavior;
          throw new Error(`createFixtureBrokerAdapter: unhandled behavior ${String(exhaustive)}`);
        }
      }
    },

    async fetchHistory(handle: AccountHandle, _since: string): Promise<Fill[]> {
      requireFixtureHandle(handle);
      return fills;
    },

    async fetchOpenPositions(handle: AccountHandle): Promise<Position[]> {
      requireFixtureHandle(handle);
      return openPositions;
    },

    async snapshotPositions(handle: AccountHandle): Promise<PositionSnap[]> {
      requireFixtureHandle(handle);
      return positionSnaps;
    },

    async capabilities(handle: AccountHandle): Promise<TierFlags> {
      requireFixtureHandle(handle);
      return tier;
    },
  };
}
