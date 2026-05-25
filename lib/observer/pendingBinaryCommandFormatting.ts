/**
 * Pure formatting helper used by observer's pending-binary-command sync
 * logger; surfaced as its own module so plan-side log builders can
 * import the same labels without dragging in the rest of observer.
 */
export function formatPendingBinaryObservedValue(
  capabilityId: 'onoff' | 'evcharger_charging',
  value: boolean | string | undefined,
): string {
  if (capabilityId === 'evcharger_charging') {
    if (value === true) return 'charging';
    if (value === false) return 'paused';
    return String(value ?? 'unknown');
  }
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value ?? 'unknown');
}
