import type { HeadroomWidgetLimitState } from '../../../packages/shared-domain/src/headroomWidgetCopy';
import type {
  SettingsUiPowerStatus,
  SettingsUiPowerStatusUnavailableReason,
} from '../../../packages/contracts/src/settingsUiApi';
import type { PelsStatus } from '../../../lib/plan/pelsStatus';
import { HEADROOM_WIDGET_COPY } from '../../../packages/shared-domain/src/headroomWidgetCopy';
import { EMPTY_SUBTITLE_DEFAULT } from './headroomWidgetConstants';
import type {
  HeadroomWidgetEmptyPayload,
  HeadroomWidgetPayload,
  HeadroomWidgetPriceLevel,
  HeadroomWidgetReadyPayload,
} from './headroomWidgetTypes';

const STALE_AFTER_MS = 90 * 1000;
const NEAR_PACE_RATIO = 0.85;
// Re-exported from the browser-safe constants module so existing consumers
// and tests keep a stable import surface off the builder.
export { EMPTY_SUBTITLE_DEFAULT };

const resolvePriceLevel = (value: SettingsUiPowerStatus['priceLevel']): HeadroomWidgetPriceLevel => {
  if (value === 'cheap') return 'cheap';
  if (value === 'expensive') return 'expensive';
  if (value === 'normal') return 'normal';
  return 'unknown';
};

/**
 * The home's in-memory status (`PelsStatus`, `lib/plan/planStatusRegistry.ts`)
 * as the shared classifier serves it. `SettingsUiPowerStatus` does not declare
 * the binding limit, which the status itself always carries.
 */
type HeadroomWidgetStatus = SettingsUiPowerStatus & { powerLimitKw?: PelsStatus['powerLimitKw'] };

/**
 * The classified status read the widget API hands in — the same shape
 * the app's own composers serve (`classifyPowerStatusRead`,
 * setup/settingsUiAppRuntime.ts), so the widget answers the liveness question
 * through the one shared classifier instead of trusting a stored status.
 * `live` still gets AGED below (`STALE_AFTER_MS`): a latched home whose meter
 * died keeps its last status, and the not-current presentation is the honest
 * render for it. `unavailable` has no vouched numbers at all and renders the
 * empty "No data yet" state — a gate-shut home (meter swap, corrupt restore,
 * first boot) must not present the previous figures as current, not even for
 * the first 90 seconds.
 */
export type HeadroomWidgetStatusRead =
  | { readonly state: 'live'; readonly status: HeadroomWidgetStatus }
  | { readonly state: 'unavailable'; readonly reason: SettingsUiPowerStatusUnavailableReason };

export type HeadroomWidgetInput = {
  status: HeadroomWidgetStatusRead;
  nowMs?: number;
};

/**
 * Resolve the at-limit state so the renderer reads a flat enum instead of
 * re-deriving kW thresholds. `over_cap` — the only red/danger state — is the
 * producer-resolved TRAJECTORY flag (projected this-hour energy past the hard
 * cap's hourly kWh, `lib/plan/pelsStatus.ts`), never instantaneous kW vs the
 * cap: the cap is an hourly-average tariff-step ceiling, so a momentary draw
 * above it is not an exceedance. Sitting at the dynamic safe pace is correct
 * operation and reads as the calmer `at_pace` state.
 */
const resolveLimitState = (
  currentKw: number,
  hourBudgetKw: number,
  projectedOverHardCap: boolean,
): HeadroomWidgetLimitState => {
  // When the status doesn't carry the flag we cannot prove the trajectory, so
  // we never escalate to `over_cap` on its absence.
  if (projectedOverHardCap) return 'over_cap';
  if (hourBudgetKw <= 0) return 'under';
  const ratio = currentKw / hourBudgetKw;
  if (ratio >= 1) return 'at_pace';
  if (ratio >= NEAR_PACE_RATIO) return 'near';
  return 'under';
};

const emptyPayload = (subtitle: string): HeadroomWidgetEmptyPayload => ({
  state: 'empty',
  subtitle,
});

export const buildHeadroomWidgetPayload = (input: HeadroomWidgetInput): HeadroomWidgetPayload => {
  if (input.status.state !== 'live') return emptyPayload(EMPTY_SUBTITLE_DEFAULT);
  const status = input.status.status;
  // The planner had no measurement behind this status: it carries no
  // headroom then, and nothing derived from it is honest to draw — not even
  // dimmed as "not current". The empty state names the cause instead (owner
  // ruling 2026-09-02; the same branch the Overview hero makes on its meta).
  if (status.powerKnown === false) return emptyPayload(HEADROOM_WIDGET_COPY.noReadingsSubtitle);

  if (status.powerLimitKw === null) return emptyPayload(HEADROOM_WIDGET_COPY.powerLimitsOffSubtitle);
  const hourBudgetKw = status.powerLimitKw;
  // The status omits `headroomKw` exactly when it sets `powerKnown: false`,
  // which the branch above already answered.
  const { headroomKw } = status;
  if (hourBudgetKw === undefined || headroomKw === undefined) return emptyPayload(EMPTY_SUBTITLE_DEFAULT);

  const currentKw = Math.max(0, hourBudgetKw - headroomKw);
  const shedCount = status.devicesOff ?? 0;
  const priceLevel = resolvePriceLevel(status.priceLevel);
  const limitState = resolveLimitState(currentKw, hourBudgetKw, status.projectedOverHardCap === true);

  const lastUpdate = status.lastPowerUpdate ?? null;
  const nowMs = input.nowMs ?? Date.now();
  const timeStale = lastUpdate === null ? true : (nowMs - lastUpdate) > STALE_AFTER_MS;
  // Time-based only: a status the planner measured, whose stamp has since
  // aged, is still the last real figure and dims rather than blanks.
  const stale = timeStale;

  const ready: HeadroomWidgetReadyPayload = {
    state: 'ready',
    currentKw,
    hourBudgetKw,
    headroomKw,
    shedCount,
    priceLevel,
    limitState,
    stale,
  };
  return ready;
};
