// Smart-task plan is rendered as an in-page view inside `index.html`, selected
// via the `page=deadline-plan` query string. Sub-page navigation used to live
// in a separate `deadline-plan.html`, but Homey's mobile WebView does not
// reliably inject the Homey SDK when the user navigates to a sub-page,
// leaving the deadline-plan surface unable to call any API. Keeping the
// deadline-plan view in the same document side-steps that lifecycle gap.

export const DEADLINE_PLAN_PAGE_PARAM = 'deadline-plan';

export const buildDeadlineHref = (deviceId: string): string => (
  `./?page=${DEADLINE_PLAN_PAGE_PARAM}&deviceId=${encodeURIComponent(deviceId)}`
);

// Detail route for a finalized smart-task plan in history. Keyed by an opaque
// stable id assigned at finalization (uuid) so a future "two identical plans
// for the same device" scenario can never collide on a derived timestamp key.
export const buildDeadlineHistoryHref = (deviceId: string, historyId: string): string => {
  const params = new URLSearchParams({
    page: DEADLINE_PLAN_PAGE_PARAM,
    deviceId,
    historyId,
  });
  return `./?${params.toString()}`;
};

export const isDeadlinePlanRoute = (search: string): boolean => (
  new URLSearchParams(search).get('page') === DEADLINE_PLAN_PAGE_PARAM
);

// Cross-link from smart-task history detail → Usage tab for the same device
// + day. The Usage surface today does not consume deviceId/date URL params
// (the filter is selected from inside the panel), so the href is a SPA root
// reference; the click handler in `deadlinePlanMount.ts` reads `data-deadline-
// usage-link` attributes on the anchor to dispatch a close-then-Usage-tab
// transition.
//
// The deviceId + dateMs are still encoded on the href so future work that
// adds Usage deviceId/date filter routing can read them off the URL without
// needing to re-thread the producer signature. Per `notes/smart-task-ui/README.md`
// "Cross-surface: vs Usage / Insights" — the asymmetric link is task → usage
// only; the reverse is noise.
export const buildUsageDayHref = (deviceId: string, dateMs: number): string => {
  const params = new URLSearchParams({
    page: 'usage',
    deviceId,
    date: new Date(dateMs).toISOString(),
  });
  return `./?${params.toString()}`;
};
