import { formatDeviceOverview } from '../../../shared-domain/src/deviceOverview.ts';
import { PLAN_REASON_CODES } from '../../../shared-domain/src/planReasonSemanticsCore.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemanticsCore.ts';

const formatRemainingSeconds = (seconds: number): string => `${Math.max(0, Math.round(seconds))}s`;

const normalizeDetailSentence = (detail: string): string => (
  detail.length > 0 ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : detail
);

const appendDetail = (text: string, detail: string | null | undefined): string => (
  detail ? `${text}. ${normalizeDetailSentence(detail)}` : text
);

type ReasonOf<Code extends DeviceReason['code']> = Extract<DeviceReason, { code: Code }>;
type ReasonFormatter<Code extends DeviceReason['code']> = (reason: ReasonOf<Code>) => string;

const asReasonFormatter = <Code extends DeviceReason['code']>(
  formatter: ReasonFormatter<Code>,
): ((reason: DeviceReason) => string) => (
  (reason) => formatter(reason as ReasonOf<Code>)
);

const formatRestoreNeedReason: ReasonFormatter<typeof PLAN_REASON_CODES.restoreNeed> = (reason) => {
  if (reason.fromTarget && reason.toTarget) {
    return `Raising target ${reason.fromTarget} to ${reason.toTarget}`;
  }
  return 'Raising the target when there is room';
};

const formatShortfallReason: ReasonFormatter<typeof PLAN_REASON_CODES.shortfall> = (reason) => {
  if (reason.needKw !== null && reason.headroomKw !== null) {
    return `Waiting for room: needs ${reason.needKw.toFixed(1)} kW, ${reason.headroomKw.toFixed(1)} kW free`;
  }
  return 'Waiting for enough room to turn on';
};

const formatInsufficientHeadroomReason: ReasonFormatter<typeof PLAN_REASON_CODES.insufficientHeadroom> = (reason) => {
  if (reason.availableKw !== null) {
    return `Waiting for room: needs ${reason.needKw.toFixed(1)} kW, ${reason.availableKw.toFixed(1)} kW free`;
  }
  return `Waiting for room: needs ${reason.needKw.toFixed(1)} kW`;
};

const formatSwitchDelayReason = (reason: DeviceReason): string => {
  const remainingSec = (reason as { remainingSec?: number }).remainingSec ?? 0;
  return `Waiting before switching again (${formatRemainingSeconds(remainingSec)})`;
};

const formatSwapPendingReason: ReasonFormatter<typeof PLAN_REASON_CODES.swapPending> = (reason) => (
  reason.targetName ? `Waiting to swap with ${reason.targetName}` : 'Waiting to swap load'
);

const formatSwappedOutReason: ReasonFormatter<typeof PLAN_REASON_CODES.swappedOut> = (reason) => (
  reason.targetName ? `Limited while ${reason.targetName} runs` : 'Limited while another device runs'
);

const REASON_SUMMARY_FORMATTERS: Partial<Record<DeviceReason['code'], (reason: DeviceReason) => string>> = {
  [PLAN_REASON_CODES.restoreNeed]: asReasonFormatter(formatRestoreNeedReason),
  [PLAN_REASON_CODES.setTarget]: asReasonFormatter<typeof PLAN_REASON_CODES.setTarget>(
    (reason) => `Changing target to ${reason.targetText}`,
  ),
  [PLAN_REASON_CODES.capacity]: asReasonFormatter<typeof PLAN_REASON_CODES.capacity>(
    (reason) => appendDetail('Paused to keep total power under the limit', reason.detail),
  ),
  [PLAN_REASON_CODES.sheddingActive]: asReasonFormatter<typeof PLAN_REASON_CODES.sheddingActive>(
    (reason) => appendDetail('Reducing load now', reason.detail),
  ),
  [PLAN_REASON_CODES.hourlyBudget]: asReasonFormatter<typeof PLAN_REASON_CODES.hourlyBudget>(
    (reason) => appendDetail("Limited to stay within this hour's budget", reason.detail),
  ),
  [PLAN_REASON_CODES.dailyBudget]: asReasonFormatter<typeof PLAN_REASON_CODES.dailyBudget>(
    (reason) => appendDetail("Limited to stay within today's budget", reason.detail),
  ),
  [PLAN_REASON_CODES.shortfall]: asReasonFormatter(formatShortfallReason),
  [PLAN_REASON_CODES.insufficientHeadroom]: asReasonFormatter(formatInsufficientHeadroomReason),
  [PLAN_REASON_CODES.cooldownShedding]: formatSwitchDelayReason,
  [PLAN_REASON_CODES.cooldownRestore]: formatSwitchDelayReason,
  [PLAN_REASON_CODES.activationBackoff]: formatSwitchDelayReason,
  [PLAN_REASON_CODES.restorePending]: formatSwitchDelayReason,
  [PLAN_REASON_CODES.meterSettling]: asReasonFormatter<typeof PLAN_REASON_CODES.meterSettling>(
    (reason) => `Waiting for meter data (${formatRemainingSeconds(reason.remainingSec)})`,
  ),
  [PLAN_REASON_CODES.headroomCooldown]: asReasonFormatter<typeof PLAN_REASON_CODES.headroomCooldown>(
    (reason) => `Letting power settle (${formatRemainingSeconds(reason.remainingSec)})`,
  ),
  [PLAN_REASON_CODES.restoreThrottled]: () => 'Waiting before turning more devices on',
  [PLAN_REASON_CODES.waitingForOtherDevices]: () => 'Waiting for other devices to settle',
  [PLAN_REASON_CODES.swapPending]: asReasonFormatter(formatSwapPendingReason),
  [PLAN_REASON_CODES.swappedOut]: asReasonFormatter(formatSwappedOutReason),
  [PLAN_REASON_CODES.inactive]: asReasonFormatter<typeof PLAN_REASON_CODES.inactive>(
    (reason) => appendDetail('Off for now', reason.detail),
  ),
  [PLAN_REASON_CODES.capacityControlOff]: () => 'Capacity control is off for this device',
  [PLAN_REASON_CODES.neutralStartupHold]: () => 'Left off after startup',
  [PLAN_REASON_CODES.startupStabilization]: () => 'Waiting after startup',
  [PLAN_REASON_CODES.shedInvariant]: () => 'Holding a lower step while load settles',
  [PLAN_REASON_CODES.other]: asReasonFormatter<typeof PLAN_REASON_CODES.other>((reason) => reason.text),
  [PLAN_REASON_CODES.keep]: () => '',
  [PLAN_REASON_CODES.none]: () => '',
};

export const formatReasonSummary = (reason: DeviceReason): string => {
  const formatter = REASON_SUMMARY_FORMATTERS[reason.code];
  return formatter ? formatter(reason) : formatDeviceOverview({ reason }).statusMsg;
};
