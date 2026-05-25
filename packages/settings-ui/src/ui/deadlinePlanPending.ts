import {
  resolveBuildingPlanChipTone,
  resolvePausedUnpluggedChipTone,
  type DeadlineLabels,
  type DeadlineLiveState,
  type DeadlinePendingContext,
  type DeadlinePendingPriceSource,
  type DeadlinePlanPendingReason,
  type SmartTaskChipTone,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { DeferredObjectiveActivePlanV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeadlinePlanPendingPayload } from './views/DeadlinePlan.tsx';
import { formatDeadlineFull, formatTarget } from './deadlinePlanFormatters.ts';

// Pending heroes share the hero chip ordering `[kind, state, …]`. The state
// chip uses the same shared label map as the live hero so the three Smart-
// task surfaces (list / hero / device card) never disagree on chip copy.
export const resolvePendingLiveState = (reason: DeadlinePlanPendingReason): DeadlineLiveState => {
  if (reason === 'invalid_session') return 'paused_unplugged';
  return 'building_plan';
};

// Pending-hero state chip tone, routed through the shared pending-tone
// resolvers the list card also reads (via `SMART_TASK_LIST_STATUS_CHIP_VARIANT`)
// so the "Building plan…" / "Paused — unplugged" pill never shows a different
// colour on the list and the detail surface. The pending hero only ever
// resolves to `building_plan` / `paused_unplugged` via
// `resolvePendingLiveState`; the broader `DeadlineLiveState` union (`active` /
// `queued` / `ok`) doesn't reach this resolver in practice, so the fallback
// simply mirrors the `building_plan` tone. Per
// `feedback_layering_resolution_in_producer.md` this consumer just calls the
// flat shared-domain helpers — it never branches on the underlying state.
export const pendingChipTone = (liveState: DeadlineLiveState): SmartTaskChipTone => {
  if (liveState === 'paused_unplugged') return resolvePausedUnpluggedChipTone();
  return resolveBuildingPlanChipTone();
};

export const resolvePendingReason = (
  activePlan: DeferredObjectiveActivePlanV1 | null,
): DeadlinePlanPendingReason => activePlan?.pendingReason ?? 'awaiting_horizon_plan';

const resolvePriceSource = (scheme: unknown): DeadlinePendingPriceSource => {
  if (scheme === 'flow') return 'external_flow';
  if (scheme === 'norway' || scheme === 'homey') return 'managed';
  return 'unknown';
};

const formatLastFetched = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

// Narrow the unknown `combinedPrices` payload to the two fields we care about
// for pending-hero copy. Returns 'unknown' / null when the payload is missing
// or unrecognised so the copy falls back to neutral wording. `deviceName` /
// `deadlineTime` are appended by `buildPendingPayload` once the resolved
// objective context is in hand — keeping the price-only fields here means
// `resolveRenderInput` can share one helper for the absent-plan and ready-
// but-no-prices branches.
export const resolvePendingPriceContext = (prices: SettingsUiPricesPayload): Pick<
  DeadlinePendingContext, 'priceSource' | 'lastFetchedShort'
> => {
  const combined = prices.combinedPrices;
  if (!combined || typeof combined !== 'object') {
    return { priceSource: 'unknown', lastFetchedShort: null };
  }
  const record = combined as { priceScheme?: unknown; lastFetched?: unknown };
  return {
    priceSource: resolvePriceSource(record.priceScheme),
    lastFetchedShort: formatLastFetched(record.lastFetched),
  };
};

export const buildPendingHero = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  labels: DeadlineLabels;
  deadlineAtMs: number;
  pendingReason: DeadlinePlanPendingReason;
  pendingContext: DeadlinePendingContext;
}): DeadlinePlanPendingPayload['hero'] => {
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const copy = params.labels.pendingHeroByReason[params.pendingReason](params.pendingContext);
  const liveState = resolvePendingLiveState(params.pendingReason);
  return {
    chips: [
      { text: params.labels.kindChipLabel, tone: 'info' },
      {
        text: params.labels.liveStateChipLabel[liveState],
        tone: pendingChipTone(liveState),
        // Liveness pulse only for the actively-working "Building plan…" chip,
        // never for the settled "Paused — unplugged" chip (where the user
        // must act, not wait). Resolved here so the view never branches on
        // liveState — it just forwards the flat boolean onto `data-pulse`.
        pulse: liveState === 'building_plan',
      },
    ],
    sectionLabel: params.labels.sectionLabel,
    headline: copy.headline,
    headlineReason: copy.headlineReason,
    subline: `${formatDisplayDeviceName(params.device.name)} • Target ${target} by ${deadline}`,
    metaLine: copy.body,
    recourse: copy.recourse,
  };
};
