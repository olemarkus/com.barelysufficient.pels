import { isPlainObjectRecord } from '../utils/appTypeGuards';

const ORIGINS = {
  eu: 'https://eu1-developer.deyecloud.com',
  am: 'https://us1-developer.deyecloud.com',
  india: 'https://india-developer.deyecloud.com',
};

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_MARGIN_MS = 15_000;
const MAX_ORDER_ID = 9_223_372_036_854_775_807n;

/** Resolved Deye Cloud account and inverter for one battery. */
export type DeyeCloudCredentials = {
  region: keyof typeof ORIGINS;
  appId: string;
  appSecret: string;
  email: string;
  passwordHash: string;
  deviceSn: string;
};

type Session = {
  credentials: DeyeCloudCredentials;
  authorization: string;
  expiresAt: number;
};

function sameAccount(left: DeyeCloudCredentials, right: DeyeCloudCredentials): boolean {
  return left.region === right.region
    && left.appId === right.appId
    && left.appSecret === right.appSecret
    && left.email === right.email
    && left.passwordHash === right.passwordHash;
}

function orderId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > MAX_ORDER_ID) return null;
  return value;
}

function parseResponse(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source: string }): unknown => {
    // The API also emits numeric int64 IDs. Keep the exact JSON token before Number loses precision.
    if (key === 'orderId' && typeof value === 'number') return context?.source;
    return value;
  });
}

const exactOrderIdProbe = parseResponse('{"orderId":1}');
const supportsExactOrderIds = isPlainObjectRecord(exactOrderIdProbe) && exactOrderIdProbe.orderId === '1';

function requireExactOrderIds(): void {
  if (!supportsExactOrderIds) throw new Error('This Homey version cannot confirm Deye Cloud orders');
}

const ACCESS_REJECTED = new Error('Deye Cloud rejected access');

type DeyeWriteResult = { kind: 'submitted'; orderId: string } | { kind: 'authorization_rejected' };

/** The actuator's Deye Cloud transport. Submission returns an order ID and execution requires a separate read. */
export class DeyeCloudClient {
  private session?: Session;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async readLimit(credentials: DeyeCloudCredentials): Promise<number> {
    requireExactOrderIds();
    const payload = await this.request(credentials, '/v1.0/config/battery', 'POST',
      await this.authorization(credentials), { deviceSn: credentials.deviceSn });
    const limit = payload.maxDischargeCurrent;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('Invalid Deye Cloud discharge current');
    }
    return limit;
  }

  async prepareLimitWrite(credentials: DeyeCloudCredentials, amps: number): Promise<() => Promise<DeyeWriteResult>> {
    requireExactOrderIds();
    if (!Number.isSafeInteger(amps) || amps < 0) throw new Error('Invalid discharge current');
    const authorization = await this.authorization(credentials);
    // Resolve access before the caller persists a submission marker. The
    // returned operation sends only the write and never refreshes a token.
    return async () => {
      try {
        const payload = await this.request(credentials, '/v1.0/order/battery/parameter/update', 'POST', authorization, {
          deviceSn: credentials.deviceSn,
          paramterType: 'MAX_DISCHARGE_CURRENT',
          value: amps,
        });
        const id = orderId(payload.orderId);
        if (!id) throw new Error('Missing Deye Cloud order ID');
        return { kind: 'submitted', orderId: id };
      } catch (error) {
        if (error === ACCESS_REJECTED) return { kind: 'authorization_rejected' };
        throw error;
      }
    };
  }

  async readOrder(credentials: DeyeCloudCredentials, id: string): Promise<'pending' | 'failed' | 'succeeded'> {
    if (!orderId(id)) throw new Error('Invalid Deye Cloud order ID');
    const payload = await this.request(credentials, `/v1.0/order/${id}`, 'GET', await this.authorization(credentials));
    if (orderId(payload.orderId) !== id) throw new Error('Unexpected Deye Cloud order ID');
    switch (payload.status) {
      case 0:
      case 100:
      case 300:
        return 'pending';
      case 400:
      case 500:
        return 'failed';
      case 666:
        return 'succeeded';
      default:
        throw new Error('Unknown Deye Cloud order status');
    }
  }

  private async authorization(credentials: DeyeCloudCredentials): Promise<string> {
    const cached = this.session;
    if (cached && sameAccount(cached.credentials, credentials) && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) {
      return cached.authorization;
    }
    const query = new URLSearchParams({ appId: credentials.appId });
    const requestedAt = Date.now();
    const payload = await this.request(credentials, `/v1.0/account/token?${query}`, 'POST', undefined, {
      appSecret: credentials.appSecret,
      email: credentials.email,
      password: credentials.passwordHash,
    });
    const token = typeof payload.accessToken === 'string' ? payload.accessToken.replace(/^Bearer /i, '') : '';
    const seconds = typeof payload.expiresIn === 'string' && /^\d+$/.test(payload.expiresIn)
      ? Number(payload.expiresIn) : payload.expiresIn;
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) {
      throw new Error('Invalid Deye Cloud authorization');
    }
    const expiresAt = requestedAt + seconds * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Expired Deye Cloud authorization');
    }
    const authorization = `Bearer ${token}`;
    this.session = { credentials, authorization, expiresAt };
    return authorization;
  }

  private async request(
    credentials: DeyeCloudCredentials,
    path: string,
    method: 'GET' | 'POST',
    authorization?: string,
    body?: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetchImpl(new URL(path, ORIGINS[credentials.region]), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        if (this.session?.authorization === authorization) this.session = undefined;
        throw ACCESS_REJECTED;
      }
      if (response.ok) {
        const payload = parseResponse(await response.text());
        if (isPlainObjectRecord(payload) && payload.success === true) return payload;
      }
    } catch (error) {
      if (error === ACCESS_REJECTED) throw error;
      // Transport errors may include the URL or response. Expose only the normalized failure.
    }
    throw new Error('Deye Cloud request could not be confirmed');
  }
}
