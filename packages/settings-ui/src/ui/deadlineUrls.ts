export const buildDeadlineHref = (deviceId: string): string => (
  `./deadline-plan.html?deviceId=${encodeURIComponent(deviceId)}&ui=redesign`
);
