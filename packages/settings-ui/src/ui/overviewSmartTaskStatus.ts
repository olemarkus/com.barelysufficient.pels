import type {
  OverviewDeferredObjectiveActivePlan,
  OverviewDeferredObjectiveActivePlans,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveRoster } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUi/prices.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { deadlineLabels } from '../../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import {
  resolveReportedCarChargeLimit,
  resolveSmartTaskListStatus,
  SMART_TASK_LIST_STATUS_LABELS,
} from '../../../shared-domain/src/smartTaskCopy/listStatus.ts';
import {
  resolveCurrentSmartTaskPendingReason,
} from '../../../shared-domain/src/smartTaskCopy/pendingReasons.ts';
import {
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLiveCause,
} from '../../../shared-domain/src/smartTaskCopy/shortfallCauses.ts';
import { formatHourLabel } from './deadlinePlanFormatters.ts';
import { resolveCannotMeetMeta } from './deadlinePlanHero.ts';
import {
  currentSessionPendingReason,
  resolvePendingPriceContext,
  resolvePendingReason,
} from './deadlinePlanPending.ts';
import { buildDeadlineHref } from './deadlineUrls.ts';

export type OverviewSmartTaskStatus = {
  deviceId: string;
  deviceName: string;
  deadlineAtMs: number;
  tone: 'alert' | 'warn' | 'muted';
  headline: string;
  body: string;
  action: { label: string; targetTab: string; deviceId?: string } | { label: string; href: string };
};

const TONE_ORDER = { alert: 0, warn: 1, muted: 2 } as const;

const resolvePendingTaskStatus = (
  deviceId: string,
  deviceName: string,
  objective: DeferredObjectiveRoster['objectivesByDeviceId'][string],
  plan: OverviewDeferredObjectiveActivePlan,
  prices: SettingsUiPricesPayload | null,
  nowMs: number,
): OverviewSmartTaskStatus | null => {
  const labels = deadlineLabels(objective.kind, plan.progressDirection ?? 'unknown');
  const reason = resolveCurrentSmartTaskPendingReason(plan.diagnosticReasonCode)
    ?? currentSessionPendingReason(plan)
    ?? resolvePendingReason(plan);
  // A new task is normally planned on the next cycle; no blocker is known yet.
  if (reason === 'not_yet_planned') return null;
  // A prices read that has not arrived is not evidence that the home has no prices.
  if (reason === 'awaiting_horizon_plan' && prices === null) return null;
  const priceContext = prices === null
    ? { priceSource: 'unknown' as const, lastFetchedShort: null, hasCurrentPrice: false }
    : resolvePendingPriceContext(prices, nowMs);
  const copy = labels.pendingHeroByReason[reason]({
    ...priceContext,
    deviceId,
    deviceName,
    deadlineTime: formatHourLabel(plan.deadlineAtMs),
  });
  const waitingNormally = reason === 'missing_capacity'
    || (reason === 'awaiting_horizon_plan' && priceContext.hasCurrentPrice);
  return {
    deviceId,
    deviceName,
    deadlineAtMs: plan.deadlineAtMs,
    tone: waitingNormally ? 'muted' : 'warn',
    headline: copy.headline,
    body: copy.body,
    action: copy.recourse ?? { label: 'View task', href: buildDeadlineHref(deviceId) },
  };
};

const resolveTaskStatus = (
  deviceId: string,
  deviceName: string,
  objective: DeferredObjectiveRoster['objectivesByDeviceId'][string],
  plan: OverviewDeferredObjectiveActivePlan,
  prices: SettingsUiPricesPayload | null,
  nowMs: number,
): OverviewSmartTaskStatus | null => {
  const status = resolveSmartTaskListStatus(plan, nowMs);
  if (status === 'satisfied' || status === 'queued' || status === 'on_track') return null;
  if ((status === 'at_risk' || status === 'cannot_meet') && plan.latest !== null) {
    const labels = deadlineLabels(objective.kind, plan.progressDirection ?? 'unknown');
    const budgetRole = resolveSmartTaskBudgetRole(plan.latest);
    const liveCause = resolveSmartTaskLiveCause(
      plan.diagnosticReasonCode, resolveReportedCarChargeLimit(plan), budgetRole,
    );
    return {
      deviceId,
      deviceName,
      deadlineAtMs: plan.deadlineAtMs,
      action: { label: 'View task', href: buildDeadlineHref(deviceId) },
      tone: status === 'cannot_meet' ? 'alert' : 'warn',
      headline: SMART_TASK_LIST_STATUS_LABELS[status],
      body: resolveCannotMeetMeta(labels, status, budgetRole, liveCause, plan.latest.floorShortfallCause),
    };
  }
  return resolvePendingTaskStatus(deviceId, deviceName, objective, plan, prices, nowMs);
};

/** Current task facts only: no dismissal history or inferred price blockers. */
export const resolveOverviewSmartTaskStatuses = (
  roster: DeferredObjectiveRoster | null,
  activePlans: OverviewDeferredObjectiveActivePlans | null,
  devices: readonly Pick<ObservedDeviceState, 'id' | 'name'>[],
  prices: SettingsUiPricesPayload | null,
  nowMs: number,
): OverviewSmartTaskStatus[] => {
  const rows: OverviewSmartTaskStatus[] = [];
  const names = new Map(devices.map((device) => [device.id, device.name]));
  for (const [deviceId, plan] of Object.entries(activePlans?.plansByDeviceId ?? {})) {
    const objective = roster?.objectivesByDeviceId[deviceId];
    if (!objective?.enabled || !Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= nowMs) continue;
    const deviceName = formatDisplayDeviceName(names.get(deviceId) ?? plan.deviceName ?? 'Device');
    const row = resolveTaskStatus(deviceId, deviceName, objective, plan, prices, nowMs);
    if (row !== null) rows.push(row);
  }
  return rows.sort((left, right) => (
    TONE_ORDER[left.tone] - TONE_ORDER[right.tone] || left.deadlineAtMs - right.deadlineAtMs
  ));
};
