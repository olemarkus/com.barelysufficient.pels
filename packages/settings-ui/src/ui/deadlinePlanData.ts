import type { SettingsUiBootstrap } from '../../../contracts/src/settingsUi/bootstrap.ts';
import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUi/prices.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { DeviceStatus } from '../../../contracts/src/deviceStatus.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanStatusV1,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type {
  DeviceDescriptor, MeasuredPowerObservedProbe, ObservedDeviceState,
} from '../../../contracts/src/types.ts';
import type { DeadlineLabels } from '../../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import type { DeadlineProgress, resolveEnergyNeededKWh } from './deadlinePlanResolvers.ts';

export const ONE_HOUR_MS = 60 * 60 * 1000;

export type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  // Import price (`total`) — the MONEY basis. The hero's delivered/planned cost
  // lines reconcile to the bill, so they must stay on this (see
  // `resolveLiveCostAndDelivery` in `deadlinePlanHero.ts`).
  price: number;
  // Planning price (`budgetPrice ?? total`) — the DISPLAY basis for the
  // schedule chart, its readout, and the trust caption, so the "at what price"
  // timeline follows the same signal the scheduler picked hours on. Equals
  // `price` for a non-prosumer (byte-identical).
  planningPrice: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

// Hours that end before `windowStartMs` are dropped so the chart does not
// render unrelated history. The runtime planner is the source of truth for the
// active plan; for a known active plan, callers pass the plan's `startedAtMs`
// (or `original.revisedAtMs`) so the chart can include past hours within the
// plan's lifetime. Without an active plan, callers pass `nowMs`.
export const collectHorizonHours = (
  deadlineAtMs: number,
  windowStartMs: number,
  prices: SettingsUiPricesPayload,
): HorizonHour[] => (
  prices.taskPricePeriods
    .map(({ endsAtMs, ...period }) => ({ ...period, endMs: endsAtMs }))
    .filter((hour) => hour.endMs > windowStartMs && hour.startsAtMs < deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);

export type ResolvedObjectiveContext = {
  device: ObservedDeviceState & MeasuredPowerObservedProbe & Pick<DeviceDescriptor, 'priority'>;
  // The plan's resolved status for the task's device, the one its Overview card
  // shows; null when the bootstrap carried no plan.
  deviceStatus: DeviceStatus | null;
  objective: DeferredObjectiveSettingsEntry;
  deviceId: string;
  deadlineAtMs: number;
  activePlan: ResolvedDeferredObjectiveActivePlanV1 | null;
  nowMs: number;
};

// A smart task the live page can draw: a committed revision, a current reading
// and prices through the deadline (`prepareObjectivePayload` in `deadlinePlan.ts`).
export type ObjectivePayloadReady = {
  ctx: ResolvedObjectiveContext & {
    activePlan: ResolvedDeferredObjectiveActivePlanV1 & { latest: DeferredObjectiveActivePlanRevisionV1 };
  };
  bootstrap: SettingsUiBootstrap;
  progress: DeadlineProgress;
  hours: HorizonHour[];
  energy: ReturnType<typeof resolveEnergyNeededKWh>;
  costDisplay: CostDisplay;
  priceUnitLabel: string;
};

// What `buildReadyPayload` derives once from an `ObjectivePayloadReady` for the
// live page's builders (hero, schedule timeline, trajectory, plan inputs).
export type DeadlinePlanSchedule = {
  labels: DeadlineLabels;
  // The status this page REPORTS: the committed verdict overlaid with the live
  // per-cycle causes (`resolveEffectivePlanStatus`), including a car stopped at
  // its own charge limit. Without the overlay a row the list marks `At risk`
  // opens on a green on-track hero until the next settle.
  planStatus: DeferredObjectiveActivePlanStatusV1;
  // Planned kWh per booked hour start (`buildChargeByStartMs`): the original
  // revision's (the latest's when there is none) and the latest's.
  originalChargeByStartMs: Map<number, number>;
  currentChargeByStartMs: Map<number, number>;
};

// Split only for presentation: booking and price boundaries may differ after a
// source-grid change or a partial first/last booking. No column spans idle time.
export const splitHorizonAtBookings = (
  hours: HorizonHour[],
  plan: ResolvedDeferredObjectiveActivePlanV1,
): HorizonHour[] => {
  const boundaries = [...(plan.original?.hours ?? []), ...(plan.latest?.hours ?? [])]
    .flatMap((booking) => [booking.coversFromMs ?? booking.startsAtMs, booking.endsAtMs]);
  return hours.flatMap((hour) => {
    const cuts = [...new Set([hour.startsAtMs, hour.endMs,
      ...boundaries.filter((atMs) => atMs > hour.startsAtMs && atMs < hour.endMs)])].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((startsAtMs, index) => ({ ...hour, startsAtMs, endMs: cuts[index + 1]! }));
  });
};
