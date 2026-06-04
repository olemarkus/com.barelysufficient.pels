import type { PlanPriceWidgetReadyPayload, WidgetTarget } from '../planPriceWidgetTypes';

const buildBucketLabels = (): string[] => Array.from(
  { length: 24 },
  (_value, index) => String(index).padStart(2, '0'),
);

export const PREVIEW_TODAY_PAYLOAD: PlanPriceWidgetReadyPayload = {
  state: 'ready',
  target: 'today',
  dateKey: '2026-03-19',
  bucketLabels: buildBucketLabels(),
  plannedKwh: [
    0.42, 0.38, 0.36, 0.35, 0.34, 0.38, 0.45, 0.58, 0.7, 0.82, 0.9, 0.94,
    0.88, 0.8, 0.74, 0.68, 0.72, 0.85, 1.02, 1.14, 1.08, 0.88, 0.66, 0.51,
  ],
  actualKwh: [
    0.39, 0.37, 0.33, 0.35, 0.31, 0.4, 0.48, 0.61, 0.69, 0.8, 0.87, null,
    null, null, null, null, null, null, null, null, null, null, null, null,
  ],
  showActual: true,
  priceSeries: [
    92, 88, 81, 79, 84, 95, 103, 118, 126, 132, 136, 128,
    119, 111, 108, 114, 127, 144, 156, 162, 149, 131, 118, 104,
  ],
  hasPriceData: true,
  currentIndex: 10,
  showNow: true,
  labelEvery: 4,
  maxPlan: 1.14,
  priceMin: 79,
  priceMax: 162,
  priceAxisUnit: 'øre/kWh',
  projectedKwh: 16.8,
  projectedCost: 19.6,
  costUnit: 'kr',
  summaryTone: 'on_track',
};

export const PREVIEW_TOMORROW_PAYLOAD: PlanPriceWidgetReadyPayload = {
  state: 'ready',
  target: 'tomorrow',
  dateKey: '2026-03-20',
  bucketLabels: buildBucketLabels(),
  plannedKwh: [
    0.36, 0.34, 0.33, 0.31, 0.3, 0.32, 0.4, 0.54, 0.68, 0.75, 0.78, 0.8,
    0.76, 0.73, 0.7, 0.72, 0.8, 0.92, 1.04, 1.09, 1.01, 0.83, 0.62, 0.48,
  ],
  actualKwh: Array.from({ length: 24 }, () => null),
  showActual: false,
  priceSeries: [
    86, 81, 77, 74, 72, 78, 93, 112, 126, 141, 148, 145,
    134, 122, 118, 123, 137, 151, 167, 173, 158, 136, 118, 99,
  ],
  hasPriceData: true,
  currentIndex: 0,
  showNow: false,
  labelEvery: 4,
  maxPlan: 1.09,
  priceMin: 72,
  priceMax: 173,
  priceAxisUnit: 'øre/kWh',
  projectedKwh: 15.6,
  projectedCost: 18.3,
  costUnit: 'kr',
  summaryTone: null,
};

// An over-budget variant of the today payload, so the screenshot harness can
// exercise the red status chip (`summary--over`) — the on_track + null tones are
// already covered by the today/tomorrow payloads, leaving the red chip otherwise
// unguarded. Selected via `?tone=over` in preview (see resolvePreviewPayload).
export const PREVIEW_OVER_PAYLOAD: PlanPriceWidgetReadyPayload = {
  ...PREVIEW_TODAY_PAYLOAD,
  projectedKwh: 24.3,
  projectedCost: 31.2,
  summaryTone: 'over',
};

// Resolve the preview payload for a target, with an optional tone override so the
// render-gate can exercise each status chip. `?tone=over` forces the red
// over-budget chip; otherwise today (on_track) / tomorrow (null) tones apply.
export const resolvePreviewPayload = (
  target: WidgetTarget,
  tone?: string | null,
): PlanPriceWidgetReadyPayload => {
  if (tone === 'over') return PREVIEW_OVER_PAYLOAD;
  return target === 'tomorrow' ? PREVIEW_TOMORROW_PAYLOAD : PREVIEW_TODAY_PAYLOAD;
};
