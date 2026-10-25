import type { SupportReportValue } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/** A value a report can carry as it is: JSON with finite numbers, as the stores read back what they kept. */
export const isSupportReportValue = (value: unknown): value is SupportReportValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSupportReportValue);
  return isUnknownRecord(value) && Object.values(value).every(isSupportReportValue);
};
