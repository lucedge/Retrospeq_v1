import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `server-only` is mocked the same way `lib/broker/__tests__/envelope-encryption.test.ts`
 * mocks it — this is a unit test of the Resend wiring/validation logic,
 * never a live-network claim (that's what a manual send via the real
 * module, done by the owner, verifies).
 */
vi.mock('server-only', () => ({}));

import {
  EmailProviderNotConfiguredError,
  EmailSendFailedError,
  getTransactionalEmailProvider,
} from '../email-provider';

const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_FROM_NAME'] as const;
const TEST_API_KEY = 're_test_do_not_leak_this_string';

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function setConfigured(): void {
  process.env.RESEND_API_KEY = TEST_API_KEY;
  process.env.EMAIL_FROM = 'hello@notifications.retrospeq.com';
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedEnv[key] = value;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('lib/privacy/email-provider.ts — configuration', () => {
  it('throws EmailProviderNotConfiguredError naming RESEND_API_KEY when it is unset', () => {
    process.env.EMAIL_FROM = 'hello@notifications.retrospeq.com';
    try {
      getTransactionalEmailProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailProviderNotConfiguredError);
      expect((err as EmailProviderNotConfiguredError).missing).toContain('RESEND_API_KEY');
      expect((err as Error).message).toMatch(/RESEND_API_KEY/);
    }
  });

  it('throws EmailProviderNotConfiguredError naming RESEND_API_KEY when it is blank', () => {
    process.env.RESEND_API_KEY = '   ';
    process.env.EMAIL_FROM = 'hello@notifications.retrospeq.com';
    expect(() => getTransactionalEmailProvider()).toThrow(EmailProviderNotConfiguredError);
  });

  it('throws EmailProviderNotConfiguredError naming EMAIL_FROM when it is unset', () => {
    process.env.RESEND_API_KEY = TEST_API_KEY;
    try {
      getTransactionalEmailProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailProviderNotConfiguredError);
      expect((err as EmailProviderNotConfiguredError).missing).toContain('EMAIL_FROM');
      expect((err as Error).message).toMatch(/EMAIL_FROM/);
    }
  });

  it('throws EmailProviderNotConfiguredError when EMAIL_FROM does not look like an email address', () => {
    process.env.RESEND_API_KEY = TEST_API_KEY;
    process.env.EMAIL_FROM = 'Retrospeq Notifications';
    try {
      getTransactionalEmailProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailProviderNotConfiguredError);
      expect((err as EmailProviderNotConfiguredError).missing).toContain('EMAIL_FROM');
    }
  });

  it('the error names "transactional email provider", not a generic message', () => {
    try {
      getTransactionalEmailProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailProviderNotConfiguredError);
      expect((err as Error).message).toMatch(/transactional email provider/i);
    }
  });

  it('never leaks a value into the thrown error message beyond the offending EMAIL_FROM itself', () => {
    process.env.RESEND_API_KEY = TEST_API_KEY;
    try {
      getTransactionalEmailProvider();
    } catch (err) {
      expect((err as Error).message).not.toContain(TEST_API_KEY);
    }
  });

  it('returns a real provider once both vars are validly set', () => {
    setConfigured();
    expect(() => getTransactionalEmailProvider()).not.toThrow();
  });
});

describe('lib/privacy/email-provider.ts — send request shape', () => {
  beforeEach(setConfigured);

  it('POSTs to the Resend endpoint with the bearer key and the from/to/subject/text JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getTransactionalEmailProvider();
    await provider.send('trader@example.com', 'Your account has been deleted', 'Body text.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Retrospeq <hello@notifications.retrospeq.com>',
      to: ['trader@example.com'],
      subject: 'Your account has been deleted',
      text: 'Body text.',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours EMAIL_FROM_NAME when set, defaults to "Retrospeq" otherwise', async () => {
    process.env.EMAIL_FROM_NAME = 'Retrospeq Notifications';
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTransactionalEmailProvider().send('trader@example.com', 'Subject', 'Body');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).from).toBe(
      'Retrospeq Notifications <hello@notifications.retrospeq.com>',
    );
  });
});

describe('lib/privacy/email-provider.ts — send failure handling', () => {
  beforeEach(setConfigured);

  it('throws a typed EmailSendFailedError on a non-2xx response, carrying status + Resend detail, never the API key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: 'validation_error', message: 'invalid `to` field' }), {
          status: 422,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = getTransactionalEmailProvider();
    try {
      await provider.send('trader@example.com', 'Subject', 'Body');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailSendFailedError);
      expect((err as EmailSendFailedError).status).toBe(422);
      expect((err as Error).message).toMatch(/422/);
      expect((err as Error).message).toMatch(/validation_error/);
      expect((err as Error).message).not.toContain(TEST_API_KEY);
    }
  });

  it('throws EmailSendFailedError with just the status when the error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getTransactionalEmailProvider();
    await expect(provider.send('trader@example.com', 'Subject', 'Body')).rejects.toMatchObject({
      name: 'EmailSendFailedError',
      status: 502,
    });
  });

  it('propagates a network/timeout error without leaking the API key', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getTransactionalEmailProvider();
    let caught: unknown;
    try {
      await provider.send('trader@example.com', 'Subject', 'Body');
      expect.unreachable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(TEST_API_KEY);
  });

  it('passes an AbortSignal (request timeout) on every call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTransactionalEmailProvider().send('trader@example.com', 'Subject', 'Body');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never retries automatically — exactly one fetch call even on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getTransactionalEmailProvider();
    await expect(provider.send('trader@example.com', 'Subject', 'Body')).rejects.toBeInstanceOf(
      EmailSendFailedError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('lib/privacy/email-provider.ts — input validation', () => {
  beforeEach(setConfigured);

  it('rejects an implausible recipient address before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = getTransactionalEmailProvider();
    await expect(provider.send('not-an-email', 'Subject', 'Body')).rejects.toThrow(/recipient/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a subject containing CR/LF (header-injection shape) before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = getTransactionalEmailProvider();
    await expect(
      provider.send('trader@example.com', 'Subject\r\nBcc: evil@example.com', 'Body'),
    ).rejects.toThrow(/line breaks/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized subject before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = getTransactionalEmailProvider();
    await expect(provider.send('trader@example.com', 'x'.repeat(500), 'Body')).rejects.toThrow(
      /subject/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty body before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = getTransactionalEmailProvider();
    await expect(provider.send('trader@example.com', 'Subject', '')).rejects.toThrow(/body/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = getTransactionalEmailProvider();
    await expect(
      provider.send('trader@example.com', 'Subject', 'x'.repeat(25_000)),
    ).rejects.toThrow(/body/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
