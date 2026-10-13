import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';

// Per-area write chains for the meter-area editor. Write ordering belongs to the
// meter area, not a rendered editor object: a quick area switch or a panel
// reactivation can replace the editor while callbacks are pending, and later
// captured intents must still run after earlier ones. Reads order against those
// writes through `admitAreaRead`.

type AreaReadOrder = {
  /** Writes to the area (caps, control or period) whose callbacks have not returned. */
  inFlight: number;
  /** Moved as each write's callback returns, whatever its outcome. */
  epoch: number;
  readDeferred: boolean;
};

const areaReadOrderByHomeId = new Map<string, AreaReadOrder>();

const areaReadOrder = (homeId: string): AreaReadOrder => {
  const existing = areaReadOrderByHomeId.get(homeId);
  if (existing !== undefined) return existing;
  const created: AreaReadOrder = { inFlight: 0, epoch: 0, readDeferred: false };
  areaReadOrderByHomeId.set(homeId, created);
  return created;
};

/** Taken as a read of the area starts; `admitAreaRead` checks it when the read lands. */
export const areaWriteEpoch = (homeId: string): number => areaReadOrder(homeId).epoch;

export const beginAreaWrite = (homeId: string): void => {
  areaReadOrder(homeId).inFlight += 1;
};

export const endAreaWrite = (homeId: string): void => {
  const order = areaReadOrder(homeId);
  order.inFlight -= 1;
  order.epoch += 1;
};

/**
 * Whether a read that started at `startEpoch` is current: no write to the area
 * is in flight and none has finished since it started. A read that is not may
 * predate a write, so it is set aside for `takeDueAreaRead`.
 */
export const admitAreaRead = (homeId: string, startEpoch: number): boolean => {
  const order = areaReadOrder(homeId);
  if (order.inFlight === 0 && order.epoch === startEpoch) return true;
  order.readDeferred = true;
  return false;
};

/** True, once, when a set-aside read is due: no write to the area remains in flight. */
export const takeDueAreaRead = (homeId: string): boolean => {
  const order = areaReadOrder(homeId);
  if (!order.readDeferred || order.inFlight > 0) return false;
  order.readDeferred = false;
  return true;
};

/** One cap field's write state on its area's chain. */
export type AreaCapFieldWrites = {
  /** The value this WebView last knew the store to hold; writing it again is a no-op. */
  persistedKw: number;
  /** Committed intents, queued or in flight, that write this field. */
  pendingCount: number;
};

export type AreaCapsWriteQueue = {
  limit: AreaCapFieldWrites;
  margin: AreaCapFieldWrites;
  latestSequence: number;
  tail: Promise<void>;
};

/** One committed cap/margin edit on an area's chain, and which fields it writes. */
export type AreaCapsIntent = {
  limitKw: number;
  marginKw: number;
  writesLimit: boolean;
  writesMargin: boolean;
  sequence: number;
};

export type AreaPeriodWriteQueue = {
  persistedPeriodMinutes: CapacityPeriodMinutes;
  latestPeriodMinutes: CapacityPeriodMinutes;
  pendingCount: number;
  latestSequence: number;
  tail: Promise<void>;
};

const areaCapsWriteQueueByHomeId = new Map<string, AreaCapsWriteQueue>();
const areaPeriodWriteQueueByHomeId = new Map<string, AreaPeriodWriteQueue>();

/**
 * This area's caps chain, with a fresh read folded in. Only an idle field takes
 * the read as its baseline: the read may predate a pending write of the field,
 * whose own callback sets the baseline.
 */
export const resolveAreaCapsWriteQueue = (homeId: string, limitKw: number, marginKw: number): AreaCapsWriteQueue => {
  const existing = areaCapsWriteQueueByHomeId.get(homeId);
  if (existing === undefined) {
    const created: AreaCapsWriteQueue = {
      limit: { persistedKw: limitKw, pendingCount: 0 },
      margin: { persistedKw: marginKw, pendingCount: 0 },
      latestSequence: 0,
      tail: Promise.resolve(),
    };
    areaCapsWriteQueueByHomeId.set(homeId, created);
    return created;
  }
  const { limit, margin } = existing;
  if (limit.pendingCount === 0) limit.persistedKw = limitKw;
  if (margin.pendingCount === 0) margin.persistedKw = marginKw;
  return existing;
};

/** This area's period chain; as for the caps, only an idle chain takes a read as its baseline. */
export const resolveAreaPeriodWriteQueue = (
  homeId: string,
  periodMinutes: CapacityPeriodMinutes,
): AreaPeriodWriteQueue => {
  const existing = areaPeriodWriteQueueByHomeId.get(homeId);
  if (existing !== undefined) {
    if (existing.pendingCount === 0) {
      existing.persistedPeriodMinutes = periodMinutes;
      existing.latestPeriodMinutes = periodMinutes;
    }
    return existing;
  }
  const created: AreaPeriodWriteQueue = {
    persistedPeriodMinutes: periodMinutes,
    latestPeriodMinutes: periodMinutes,
    pendingCount: 0,
    latestSequence: 0,
    tail: Promise.resolve(),
  };
  areaPeriodWriteQueueByHomeId.set(homeId, created);
  return created;
};
