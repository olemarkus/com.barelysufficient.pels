import type { HeadroomWidgetReadyPayload } from '../headroomWidgetTypes';

export const PREVIEW_HEADROOM_PAYLOAD: HeadroomWidgetReadyPayload = {
  state: 'ready',
  currentKw: 3.2,
  hourBudgetKw: 7.0,
  headroomKw: 3.8,
  shedCount: 2,
  priceLevel: 'cheap',
  stale: false,
};
