import type { SettingsUiHardCapShortfall } from '../../../contracts/src/settingsUi/power.ts';
import type { CapacityScalarSettings } from '../../../contracts/src/capacitySettings.ts';
import { getDateKeyInTimeZone, shiftDateKey } from '../../../shared-domain/src/utils/dateUtils.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import type { SetupRecommendation } from './recommendationsModel.ts';
import { logSettingsError } from './logging.ts';
import { getPowerReadModel } from './power.ts';

/**
 * A hard cap this home keeps running into with nothing left for PELS to ease
 * off. Once in a while is what the hard-cap alerts are for; on several days a
 * week it is the setup, and the owner can only change it by letting PELS
 * control more of the load. Never by raising the cap: the cap is the owner's
 * tariff step, not a tuning knob (`notes/ui-terminology.md` § "Hard cap is a
 * capacity-period ceiling").
 */
export type HardCapReachFacts = {
  scalars: CapacityScalarSettings;
  shortfalls: readonly SettingsUiHardCapShortfall[];
};

const WINDOW_DAYS = 7;
const MIN_DAYS = 3;
const CAP_EPSILON_KW = 1e-6;

const isShortfall = (value: unknown): value is SettingsUiHardCapShortfall => isUnknownRecord(value)
  && typeof value.atMs === 'number' && Number.isFinite(value.atMs)
  && typeof value.hardCapKw === 'number' && Number.isFinite(value.hardCapKw) && value.hardCapKw > 0
  && typeof value.uncontrolledW === 'number' && Number.isFinite(value.uncontrolledW) && value.uncontrolledW >= 0;

/** The payload's incidents, read once at the transport seam; an entry that does not read is dropped. */
export const classifyHardCapShortfalls = (raw: unknown): SettingsUiHardCapShortfall[] => (
  Array.isArray(raw) ? raw.filter(isShortfall) : []
);

let facts: HardCapReachFacts | null = null;
let readStatus: 'loading' | 'resolved' | 'unavailable' = 'loading';
let readGeneration = 0;

export const readHardCapReachStatus = () => readStatus;

/**
 * Reads the Main power payload the Limits form and the stale-data banner
 * already load (a cached read). An unavailable read keeps the last facts: an
 * unread log is not a week without incidents.
 */
export const loadHardCapReachFacts = async (): Promise<void> => {
  const generation = ++readGeneration;
  try {
    const power = await getPowerReadModel();
    if (generation !== readGeneration) return;
    if (power.capacityScalars.state !== 'resolved'
      || (power.hardCapShortfalls !== undefined && !Array.isArray(power.hardCapShortfalls))) {
      readStatus = 'unavailable';
      return;
    }
    readStatus = 'resolved';
    facts = { scalars: power.capacityScalars.scalars, shortfalls: classifyHardCapShortfalls(power.hardCapShortfalls) };
  } catch (error) {
    if (generation !== readGeneration) return;
    readStatus = 'unavailable';
    await logSettingsError('Failed to read hard cap incidents for recommendations', error, 'setup recommendations');
  }
};

export const readHardCapReachFacts = (): HardCapReachFacts | null => facts;

const formatKw = (kw: number): string => `${(Math.round(kw * 10) / 10).toFixed(1)} kW`;

const lastLocalDays = (nowMs: number, timeZone: string): Set<string> => {
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  return new Set(Array.from({ length: WINDOW_DAYS }, (_, back) => shiftDateKey(todayKey, -back)));
};

/**
 * Counts only incidents under the hard cap in force now: an owner who changed
 * the cap starts a new record. The version is that cap, so a dismissal holds
 * while it stands.
 */
export const resolveHardCapReachRecommendations = (
  read: HardCapReachFacts | null,
  nowMs: number,
  timeZone: string,
): SetupRecommendation[] => {
  if (read === null || !read.scalars.capacityEnabled) return [];
  const hardCapKw = read.scalars.limitKw;
  const days = lastLocalDays(nowMs, timeZone);
  const counted = read.shortfalls.filter((entry) => Math.abs(entry.hardCapKw - hardCapKw) < CAP_EPSILON_KW
    && entry.atMs <= nowMs && days.has(getDateKeyInTimeZone(new Date(entry.atMs), timeZone)));
  const dayCount = new Set(counted.map((entry) => getDateKeyInTimeZone(new Date(entry.atMs), timeZone))).size;
  if (dayCount < MIN_DAYS) return [];
  const uncontrolledKw = counted.reduce((sum, entry) => sum + entry.uncontrolledW, 0) / counted.length / 1000;
  const uncontrolled = uncontrolledKw >= 0.05
    ? ` Devices PELS does not control drew about ${formatKw(uncontrolledKw)} at those times.`
    : '';
  return [{
    id: 'capacity:hard-cap-out-of-reach',
    version: Math.round(hardCapKw * 1000),
    category: 'recommendation',
    title: `The ${formatKw(hardCapKw)} hard cap is often out of reach`,
    body: `On ${dayCount} of the last ${WINDOW_DAYS} days, the home was on pace to exceed the hard cap `
      + `and PELS had nothing left it could turn down.${uncontrolled} `
      + 'To stay under it, let PELS control more of the load: add devices, '
      + 'or turn Power-limit control back on for a device.',
    actionLabel: 'Review devices',
    target: { kind: 'panel', panelId: 'devices' },
  }];
};
