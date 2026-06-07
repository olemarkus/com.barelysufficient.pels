/**
 * Pure formatting helper used by observer's pending-binary-command sync
 * logger; surfaced as its own module so plan-side log builders can
 * reuse the same labels without dragging in the rest of observer.
 */
import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';

export function formatPendingBinaryObservedValue(
  capabilityId: BinaryControlCapabilityId,
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
