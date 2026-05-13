export const buildDeadlineHref = (deviceId: string): string => (
  `./deadline-plan.html?deviceId=${encodeURIComponent(deviceId)}`
);

// Detail route for a finalized smart-task plan in history. Keyed by an opaque
// stable id assigned at finalization (uuid) so a future "two identical plans
// for the same device" scenario can never collide on a derived timestamp key.
export const buildDeadlineHistoryHref = (deviceId: string, historyId: string): string => (
  `./deadline-plan.html?deviceId=${encodeURIComponent(deviceId)}&historyId=${encodeURIComponent(historyId)}&ui=redesign`
);
