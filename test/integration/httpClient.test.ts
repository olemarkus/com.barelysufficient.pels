import type { Mock } from 'vitest';
import https from 'https';
import { httpsGetJson, PINNED_CA_BUNDLE } from '../../lib/utils/httpClient';

// Mock the https outward seam (same shape as prices.test.ts).
vi.mock('https', () => ({
  default: {
    get: vi.fn(),
  },
}));

const mockGet = https.get as unknown as Mock;

const PINNED_URL = 'https://www.hvakosterstrommen.no/api/v1/prices/2026/06-30_NO3.json';
const OTHER_URL = 'https://example.com/data.json';

type Recorded = { url: string; options: { rejectUnauthorized?: boolean; ca?: string } };

type Outcome =
  | { ok: true; status?: number; body?: unknown }
  | { ok: false; code: string; message?: string };

// A response whose `on('data'|'end')` fire synchronously, like the real mock helper.
const successResponse = (status: number, body: unknown) => ({
  statusCode: status,
  statusMessage: status === 200 ? 'OK' : 'Error',
  on: vi.fn((event: string, cb: (chunk?: string) => void) => {
    if (event === 'data') cb(JSON.stringify(body));
    if (event === 'end') cb();
  }),
});

// A request that fires its 'error' handler synchronously on registration —
// httpsGetJson attaches `req.on('error', …)` right after https.get returns.
const erroringRequest = (code: string, message: string) => {
  const req: Record<string, unknown> = { setTimeout: vi.fn(), destroy: vi.fn() };
  req.on = vi.fn((event: string, handler: (err: NodeJS.ErrnoException) => void) => {
    if (event === 'error') {
      const err = new Error(message) as NodeJS.ErrnoException;
      err.code = code;
      handler(err);
    }
    return req;
  });
  return req;
};

// Drive https.get through an ordered list of per-call outcomes; record each call's TLS options.
const installOutcomes = (outcomes: Outcome[]): Recorded[] => {
  const calls: Recorded[] = [];
  let index = 0;
  mockGet.mockImplementation((url: string, options: Recorded['options'], callback: (res: unknown) => void) => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    calls.push({ url, options });
    if (outcome.ok) {
      callback(successResponse(outcome.status ?? 200, outcome.body ?? []));
      return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
    }
    return erroringRequest(outcome.code, outcome.message ?? 'error');
  });
  return calls;
};

const SSL_CODE = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'; // the exact code seen against the live cert

describe('httpsGetJson TLS strategy escalation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('tries the default trust store first for a pinned host and uses it when it works', async () => {
    const calls = installOutcomes([{ ok: true, body: [{ NOK_per_kWh: 0.35 }] }]);

    const result = await httpsGetJson(PINNED_URL);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.rejectUnauthorized).toBe(true);
    expect(calls[0].options.ca).toBeUndefined(); // default store, not the pinned bundle
    expect(result).toEqual([{ NOK_per_kWh: 0.35 }]);
  });

  it('falls back to the pinned CA bundle when the default store fails TLS', async () => {
    const log = vi.fn();
    const calls = installOutcomes([
      { ok: false, code: SSL_CODE },
      { ok: true, body: [{ ok: 1 }] },
    ]);

    const result = await httpsGetJson(PINNED_URL, { log });

    expect(calls).toHaveLength(2);
    expect(calls[0].options.ca).toBeUndefined();
    expect(calls[1].options.ca).toBe(PINNED_CA_BUNDLE);
    expect(calls[1].options.rejectUnauthorized).toBe(true);
    expect(result).toEqual([{ ok: 1 }]);
    // One TLS fallback occurred → exactly one diagnostic emitted. Assert the
    // structural fact, not the log wording (the call-option asserts above
    // already prove the default → pinned escalation).
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('falls back to insecure only after both default and pinned fail TLS', async () => {
    const calls = installOutcomes([
      { ok: false, code: SSL_CODE },
      { ok: false, code: SSL_CODE },
      { ok: true, body: { done: true } },
    ]);

    const result = await httpsGetJson(PINNED_URL);

    expect(calls).toHaveLength(3);
    expect(calls[0].options.ca).toBeUndefined();
    expect(calls[1].options.ca).toBe(PINNED_CA_BUNDLE);
    expect(calls[2].options.rejectUnauthorized).toBe(false); // insecure, last resort
    expect(result).toEqual({ done: true });
  });

  it('skips the pinned bundle for a non-pinned host (default → insecure)', async () => {
    const calls = installOutcomes([
      { ok: false, code: SSL_CODE },
      { ok: true, body: [] },
    ]);

    await httpsGetJson(OTHER_URL);

    expect(calls).toHaveLength(2);
    expect(calls[0].options.ca).toBeUndefined();
    expect(calls.some((c) => c.options.ca === PINNED_CA_BUNDLE)).toBe(false);
    expect(calls[1].options.rejectUnauthorized).toBe(false);
  });

  it('does not escalate on a non-TLS error — rejects immediately', async () => {
    const calls = installOutcomes([{ ok: false, code: 'ECONNRESET', message: 'socket hang up' }]);

    await expect(httpsGetJson(PINNED_URL)).rejects.toThrow('socket hang up');
    expect(calls).toHaveLength(1); // no fallback attempted
  });

  it('stops at the pinned bundle when allowInsecureFallback is false', async () => {
    const calls = installOutcomes([
      { ok: false, code: SSL_CODE },
      { ok: false, code: SSL_CODE },
    ]);

    await expect(httpsGetJson(PINNED_URL, { allowInsecureFallback: false })).rejects.toThrow();
    expect(calls).toHaveLength(2); // default + pinned only, never insecure
    expect(calls.some((c) => c.options.rejectUnauthorized === false)).toBe(false);
  });

  it('rejects a 404 with a NotFoundError carrying statusCode 404', async () => {
    installOutcomes([{ ok: true, status: 404 }]);

    await expect(httpsGetJson(PINNED_URL)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a non-200, non-404 response without escalating', async () => {
    const calls = installOutcomes([{ ok: true, status: 500 }]);

    await expect(httpsGetJson(PINNED_URL)).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(1);
  });
});
