import type { HeadroomWidgetLimitState } from '../../../../packages/shared-domain/src/headroomWidgetCopy';
import type { HeadroomWidgetReadyPayload } from '../headroomWidgetTypes';

// Design-preview payloads for the `?preview=1` path (dashboard gallery thumbnail
// + local previews). One per limit-state so the at-limit softening (amber
// `at_pace` / red `over_cap`) is visible in preview, not just `under` — the
// gallery + any visual capture would otherwise never exercise the at-limit copy.
// Selected by `?state=<limitState>` in preview; defaults to `under`.
export const PREVIEW_HEADROOM_PAYLOADS: Record<HeadroomWidgetLimitState, HeadroomWidgetReadyPayload> = {
  under: {
    state: 'ready',
    currentKw: 3.2,
    hourBudgetKw: 7.0,
    headroomKw: 3.8,
    overageKw: 0,
    shedCount: 2,
    priceLevel: 'cheap',
    limitState: 'under',
    stale: false,
  },
  near: {
    state: 'ready',
    currentKw: 6.3,
    hourBudgetKw: 7.0,
    headroomKw: 0.7,
    overageKw: 0,
    shedCount: 2,
    priceLevel: 'normal',
    limitState: 'near',
    stale: false,
  },
  at_pace: {
    state: 'ready',
    currentKw: 7.0,
    hourBudgetKw: 7.0,
    headroomKw: 0,
    overageKw: 0,
    shedCount: 3,
    priceLevel: 'expensive',
    limitState: 'at_pace',
    stale: false,
  },
  over_cap: {
    state: 'ready',
    currentKw: 8.4,
    hourBudgetKw: 7.0,
    headroomKw: 0,
    overageKw: 1.4,
    shedCount: 4,
    priceLevel: 'expensive',
    limitState: 'over_cap',
    stale: false,
  },
};

// Default preview state (keeps the original single-payload import working).
export const PREVIEW_HEADROOM_PAYLOAD: HeadroomWidgetReadyPayload = PREVIEW_HEADROOM_PAYLOADS.under;

const isPreviewLimitState = (state: string | null): state is HeadroomWidgetLimitState => (
  state !== null && Object.prototype.hasOwnProperty.call(PREVIEW_HEADROOM_PAYLOADS, state)
);

// Resolve the preview payload for an optional `?state=` selector, falling back
// to `under` for an absent/unknown value.
export const resolveHeadroomPreviewPayload = (
  state: string | null,
): HeadroomWidgetReadyPayload => (
  isPreviewLimitState(state) ? PREVIEW_HEADROOM_PAYLOADS[state] : PREVIEW_HEADROOM_PAYLOAD
);
