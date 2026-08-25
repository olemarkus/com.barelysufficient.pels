/**
 * HTTP error status (>= 400, or a response with no status code) from the Homey
 * local Web API transport (`lib/device/transport/managerHomeyApi.ts`). Carries
 * the status as data so consumers classify on `statusCode`, never by parsing
 * the message. Own file next to `errorUtils.ts` (max-classes-per-file).
 */
export class HomeyHttpStatusError extends Error {
  constructor(readonly statusCode: number | undefined, bodySlice: string) {
    super(`HTTP ${statusCode}: ${bodySlice}`);
    this.name = 'HomeyHttpStatusError';
  }
}

/** Name-based as well as `instanceof` so the classification survives a realm
 *  boundary or a re-thrown copy — the same rationale as `isHomeyRequestTimeout`. */
export const resolveHomeyHttpStatusCode = (value: unknown): number | undefined => {
  if (!(value instanceof Error) || value.name !== 'HomeyHttpStatusError') return undefined;
  const statusCode = (value as HomeyHttpStatusError).statusCode;
  return typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : undefined;
};
