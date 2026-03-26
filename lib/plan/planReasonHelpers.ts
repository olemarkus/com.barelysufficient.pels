import type { DevicePlanDevice } from './planTypes';
import { computeBaseRestoreNeed } from './planRestoreSwap';

export function shouldNormalizeKeepReason(reason: string | undefined): boolean {
  if (!reason) return true;
  return reason === 'keep'
    || reason.startsWith('keep (')
    || reason.startsWith('restore (need')
    || reason.startsWith('set to ');
}

export function getBaseShedReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, string>;
  activeOvershoot: boolean;
  inCooldown: boolean;
  shedCooldownRemainingSec: number | null;
}): string {
  const {
    dev,
    shedReasons,
    activeOvershoot,
    inCooldown,
    shedCooldownRemainingSec,
  } = params;
  const isSwapReason = typeof dev.reason === 'string'
    && (dev.reason.includes('swapped out') || dev.reason.includes('swap pending'));
  const hasSpecialReason = typeof dev.reason === 'string'
    && (dev.reason.includes('shortfall')
      || isSwapReason
      || dev.reason.includes('hourly budget')
      || dev.reason.includes('daily budget'));
  const baseReason = shedReasons.get(dev.id)
    || (hasSpecialReason && dev.reason)
    || 'shed due to capacity';
  if (inCooldown && !activeOvershoot && !dev.reason?.includes('swap')) {
    return `cooldown (shedding, ${shedCooldownRemainingSec ?? 0}s remaining)`;
  }
  return baseReason;
}

export function buildBaseReason(
  dev: DevicePlanDevice,
  shedReasons: Map<string, string>,
): string {
  const keepReason = dev.reason
    && dev.reason !== 'keep'
    && !dev.reason.startsWith('keep (')
    && !dev.reason.startsWith('restore (need')
    && !dev.reason.startsWith('set to ')
    ? dev.reason
    : null;
  return shedReasons.get(dev.id) || keepReason || 'shed due to capacity';
}

export function maybeApplyShortfallReason(params: {
  dev: DevicePlanDevice;
  guardInShortfall: boolean;
  reasonFlags: { isSwapReason: boolean; isBudgetReason: boolean; isShortfallReason: boolean };
  headroomRaw: number | null;
}): string | null {
  const { dev, guardInShortfall, reasonFlags, headroomRaw } = params;
  if (!guardInShortfall || reasonFlags.isSwapReason || reasonFlags.isBudgetReason) return null;
  if (dev.reason?.startsWith('shortfall (')) return null;
  const { needed: estimatedNeed } = computeBaseRestoreNeed(dev);
  return `shortfall (need ${estimatedNeed.toFixed(2)}kW, headroom `
    + `${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`;
}

export function getReasonFlags(reason: string | undefined): {
  isSwapReason: boolean;
  isBudgetReason: boolean;
  isShortfallReason: boolean;
} {
  return {
    isSwapReason: Boolean(reason && (reason.includes('swap pending') || reason.includes('swapped out'))),
    isBudgetReason: Boolean(reason && (reason.includes('hourly budget') || reason.includes('daily budget'))),
    isShortfallReason: Boolean(reason && reason.includes('shortfall')),
  };
}

export function maybeApplyCooldownReason(params: {
  reasonFlags: { isSwapReason: boolean; isBudgetReason: boolean; isShortfallReason: boolean };
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
  inRestoreCooldown: boolean;
  restoreCooldownRemainingSec: number | null;
}): string | null {
  const {
    reasonFlags,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    inRestoreCooldown,
    restoreCooldownRemainingSec,
  } = params;
  if (inCooldown && !activeOvershoot && !reasonFlags.isSwapReason) {
    return `cooldown (shedding, ${shedCooldownRemainingSec ?? 0}s remaining)`;
  }
  if (
    inRestoreCooldown
    && !activeOvershoot
    && !reasonFlags.isSwapReason
    && !reasonFlags.isBudgetReason
    && !reasonFlags.isShortfallReason
  ) {
    return `cooldown (restore, ${restoreCooldownRemainingSec ?? 0}s remaining)`;
  }
  return null;
}
