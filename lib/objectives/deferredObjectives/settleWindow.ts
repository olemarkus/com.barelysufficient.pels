const ONE_HOUR_MS = 60 * 60 * 1000;

// The plan re-optimisation settles once per clock hour, near the end (the `:58`
// mark). Shared by the active-plan recorder's write gate (`isReplanDueThisCycle`)
// and the diagnostics-build allocate-vs-frozen gate so the two clocks agree on a
// single definition of "the hour's settle window". See
// notes/deferred-load-objectives/execution-adaptation.md.
export const SCHEDULE_SETTLE_OFFSET_MS = 58 * 60 * 1000;

// True once `nowMs` is at/after the `:58` settle mark of its clock hour. Pure
// (UTC-ms floor, so a 23/25-hour DST day does not perturb the boundary — see
// reference_live_plan_earliest_hour_not_current).
export const isPastHourSettleMark = (nowMs: number): boolean => (
  nowMs - Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS >= SCHEDULE_SETTLE_OFFSET_MS
);
