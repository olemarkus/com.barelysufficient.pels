import type { WidgetErrorReporter } from '../widgetClientLog';
import type { WidgetHomeyBase } from '../widgetRuntime';
import type {
  CreateSmartTaskCandidateRequest,
  CreateSmartTaskCreateResponse,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskQuickTargetsResponse,
} from './types';

/**
 * The creation flow's three requests. Each widget that hosts the flow serves
 * the same routes (`/quick_targets`, `/preview`, `/create`), so one client
 * serves them all. Transport failures come back in the contract's own refusal
 * shape so the controller never has to try/catch.
 *
 * The canned `PREVIEW_*` payloads are CONFINED to the `?preview=1` design-
 * preview path. On a real boot with no API client yet (the SDK bridge hasn't
 * supplied one, or it failed to load) the requests report `unavailable`, never
 * canned data: a user must never see a "Created" flash while nothing was
 * created.
 */
export type SmartTaskCreateClient = {
  quickTargets(deviceId: string): Promise<CreateSmartTaskQuickTargetsResponse>;
  preview(request: CreateSmartTaskCandidateRequest): Promise<CreateSmartTaskPreviewResponse>;
  create(request: CreateSmartTaskCandidateRequest): Promise<CreateSmartTaskCreateResponse>;
};

// Preview-mode response (used when the widget runs with `?preview=1` or no
// Homey API is wired). Kept tiny and obviously fictional. Hours are floored to
// the top of the hour so the rendered window reads as a clean "HH:00–HH:00"
// range in the demo, matching how real hour-aligned plan buckets render.
const HOUR_MS = 60 * 60 * 1000;
// Fixed narrative evening (today 19:00 local) so the demo chart's hour ticks
// read coherently with the fixed "Scheduled 02:00–04:00" / "before 07:00" copy,
// regardless of when the preview is captured. Real responses carry
// backend-resolved (DST-safe) timestamps; this is `?preview=1`-only demo data.
const PREVIEW_NEXT_HOUR_MS = (() => {
  const base = new Date();
  base.setHours(19, 0, 0, 0);
  return base.getTime();
})();
// Demo price curve across the preview window (narratively 19:00 → 07:00): an
// evening level, an overnight trough, then the morning climb to the deadline.
// The two scheduled hours sit at the bottom of the trough (02:00–03:00) so the
// preview chart visibly "picked the cheap hours". øre/kWh; obviously fictional,
// confined to the `?preview=1` path. Index 0 = now (top of the next hour).
const PREVIEW_PRICE_CURVE = [92, 79, 74, 63, 59, 66, 51, 44, 48, 69, 81, 107, 119];
// Scheduled at the trough (indices 7 & 8 → "02:00" / "03:00").
const PREVIEW_SCHEDULED_INDEX = [7, 8];
const PREVIEW_RESPONSE: CreateSmartTaskPreviewResponse = {
  ok: true,
  deadlineAtMs: PREVIEW_NEXT_HOUR_MS + 12 * HOUR_MS,
  deadlineLabel: 'Tomorrow 07:00',
  // Server-formatted in real responses; a fixed demo window here.
  scheduledWindowLabel: '02:00–04:00',
  estimate: {
    budgetRole: 'none',
    status: 'on_track',
    scheduledHours: PREVIEW_SCHEDULED_INDEX.map((index) => ({
      startsAtMs: PREVIEW_NEXT_HOUR_MS + index * HOUR_MS,
      plannedKWh: 2,
    })),
    projectedFinishAtMs: PREVIEW_NEXT_HOUR_MS + 9 * HOUR_MS,
    energyEstimateKWh: 4,
    energyExpectedKWh: 3.6,
    costEstimate: 4.2,
    costUnit: 'kr',
    priceSeries: PREVIEW_PRICE_CURVE.map((price, index) => ({
      startsAtMs: PREVIEW_NEXT_HOUR_MS + index * HOUR_MS,
      price,
    })),
  },
};

// Demo quick targets for `?preview=1`, timed to the fictional evening above.
const PREVIEW_QUICK_TARGETS: CreateSmartTaskQuickTargetsResponse = {
  state: 'ready',
  targets: [[65, '20:00', '19:30'], [70, '21:00', '20:20'], [75, '21:30', '21:10'], [80, '22:30', '22:00']]
    .map(([target, by, likely], index) => ({
      target: target as number,
      deadlineAtMs: PREVIEW_NEXT_HOUR_MS + (index + 1) * HOUR_MS,
      readyByLocalTime: by as string,
      deadlineLabel: `Today ${by as string}`,
      likelyFinishLocalTime: likely as string,
      estimate: { ...PREVIEW_RESPONSE.estimate, energyEstimateKWh: 3.4 + index, costEstimate: 5.2 + index },
    })),
};

const PREVIEW_CLIENT: SmartTaskCreateClient = {
  quickTargets: async () => PREVIEW_QUICK_TARGETS,
  preview: async () => PREVIEW_RESPONSE,
  create: async () => ({ ok: true }),
};

/** The client for `homey`'s widget API, or the canned demo one in preview mode. */
export const createSmartTaskCreateClient = (
  getHomey: () => WidgetHomeyBase | null,
  usePreviewData: () => boolean,
  reporter: WidgetErrorReporter,
): SmartTaskCreateClient => {
  const call = async <T>(path: string, body: unknown, refused: T, failure: string): Promise<T> => {
    const homey = getHomey();
    if (!homey) return refused;
    try {
      return await homey.api('POST', path, body) as T;
    } catch (error) {
      reporter.report('error', failure, error);
      return refused;
    }
  };
  return {
    quickTargets: (deviceId) => (usePreviewData() ? PREVIEW_CLIENT.quickTargets(deviceId) : call(
      '/quick_targets', { deviceId }, { state: 'rejected', reason: 'unavailable' },
      'Failed to load smart task quick targets',
    )),
    preview: (request) => (usePreviewData() ? PREVIEW_CLIENT.preview(request) : call(
      '/preview', request, { ok: false, reason: 'unavailable' }, 'Failed to preview smart task',
    )),
    create: (request) => (usePreviewData() ? PREVIEW_CLIENT.create(request) : call(
      '/create', request, { ok: false, reason: 'unavailable' }, 'Failed to create smart task',
    )),
  };
};
