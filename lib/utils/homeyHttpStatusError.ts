import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/**
 * HTTP error status (>= 400, or a response with no status code) from the Homey
 * local Web API transport (`lib/device/transport/managerHomeyApi.ts`). Carries
 * the status as data so consumers classify on `statusCode`, never by parsing
 * the message. Own file next to `errorUtils.ts` (max-classes-per-file).
 */
export class HomeyHttpStatusError extends Error {
  /** Homey's structured error fields from the full response, independent of the bounded log message. */
  readonly errorFields: readonly string[];

  constructor(readonly statusCode: number | undefined, body: string) {
    super(`HTTP ${statusCode}: ${body.slice(0, 200)}`);
    this.name = 'HomeyHttpStatusError';
    this.errorFields = readHomeyErrorFields(body);
  }
}

function readHomeyErrorFields(body: string): string[] {
  try {
    const payload: unknown = JSON.parse(body);
    if (isUnknownRecord(payload)) {
      return [payload.error, payload.error_description].filter((value): value is string => typeof value === 'string');
    }
  } catch { /* Homey can also return an HTML or plain-text HTTP error. */ }
  return [];
}

/** Name-based as well as `instanceof` so the classification survives a realm
 *  boundary or a re-thrown copy — the same rationale as `isHomeyRequestTimeout`. */
export const resolveHomeyHttpStatusCode = (value: unknown): number | undefined => {
  if (!(value instanceof Error) || value.name !== 'HomeyHttpStatusError') return undefined;
  const statusCode = (value as HomeyHttpStatusError).statusCode;
  return typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : undefined;
};
