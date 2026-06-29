import type { ClassifiedPlanReason } from './planReasonStrings';

export function shouldNormalizeReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'none'
    || reason.code === 'keep'
    || reason.code === 'restore_need'
    || reason.code === 'set_target';
}

export function isSwapReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'swap_pending' || reason.code === 'swapped_out';
}

export function isBudgetReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'hourly_budget' || reason.code === 'daily_budget';
}

export function isShortfallReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'shortfall';
}
