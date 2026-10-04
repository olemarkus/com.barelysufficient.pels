import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { isCanonicalHomeyDeviceId } from '../utils/homeyDeviceId';
import { isCalendarDateKey } from '../../packages/shared-domain/src/utils/dateUtils';

type DailyKwhTotals = { total?: number; controlled?: number; uncontrolled?: number };
type MeterScopeMarkers = Pick<WeatherHistoryState, 'meterScopeSignature' | 'meterScopeSinceDateKey'>;

const FLOW_SIGNATURE = 'source:flow';
const HOMEY_ENERGY_EXPLICIT_SIGNATURE_PREFIX = 'source:homey_energy|main:';

const isValidMeterScopeSignature = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (value === FLOW_SIGNATURE) return true;
  // A persisted signature from the retired `main:automatic|areas:*` arm fails
  // this check on purpose: the documented invalid-pair policy then adopts the
  // live explicit signature WITHOUT forgetting kWh history — the upgrade path.
  if (!value.startsWith(HOMEY_ENERGY_EXPLICIT_SIGNATURE_PREFIX)) return false;
  return isCanonicalHomeyDeviceId(value.slice(HOMEY_ENERGY_EXPLICIT_SIGNATURE_PREFIX.length));
};

/**
 * Reads tracker evidence only for full local days measured under the current
 * meter scope. The transition day is excluded because its daily bucket may
 * contain samples from both arrangements.
 */
export function readMeterScopeDailyKwh(
  state: WeatherHistoryState,
  dateKey: string,
  getDailyKwh: (key: string) => DailyKwhTotals,
): DailyKwhTotals {
  if (state.meterScopeSinceDateKey !== undefined && dateKey <= state.meterScopeSinceDateKey) return {};
  return getDailyKwh(dateKey);
}

/**
 * Normalizes the persisted signature/epoch pair without admitting an orphaned
 * or malformed half. The pair is destructive evidence: the collector strips
 * retained kWh on a signature mismatch, while a future/impossible epoch can
 * suppress tracker evidence indefinitely. If either present field is invalid,
 * admit neither; the collector then adopts the live signature without
 * forgetting.
 */
export function normalizeMeterScopeMarkers(
  raw: Record<string, unknown>,
  currentDateKey?: string,
): MeterScopeMarkers {
  if (!isValidMeterScopeSignature(raw.meterScopeSignature)) return {};
  if (raw.meterScopeSinceDateKey !== undefined && !isCalendarDateKey(raw.meterScopeSinceDateKey)) return {};
  if (
    isCalendarDateKey(raw.meterScopeSinceDateKey)
    && currentDateKey !== undefined
    && raw.meterScopeSinceDateKey > currentDateKey
  ) return {};
  return {
    meterScopeSignature: raw.meterScopeSignature,
    ...(isCalendarDateKey(raw.meterScopeSinceDateKey)
      ? { meterScopeSinceDateKey: raw.meterScopeSinceDateKey }
      : {}),
  };
}
