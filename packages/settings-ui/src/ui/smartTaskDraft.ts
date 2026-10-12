import type { DeferredObjectivePlanPreviewStatus } from '../../../contracts/src/deferredObjectivePlanPreview.ts';
import type { SettingsUiSmartTaskPreviewResponse } from '../../../contracts/src/smartTaskEdit.ts';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
  formatDeadlineCostMetaLine,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../shared-domain/src/deadlineLabels.ts';

// What creating a Smart task and editing one share in the settings UI: how a
// typed goal and ready-by time are read, and how a server preview is shown.
// One copy, so the two forms accept the same input and a verdict never reads
// in two ways.

/** A 24-hour local "HH:mm", the shape the server resolves against the Homey timezone. */
export const SMART_TASK_READY_BY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A typed goal as a number, or `null` when it does not read as one. */
export const parseSmartTaskGoal = (raw: string): number | null => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The colour role of a preview's verdict line (`data-tone`). */
export type SmartTaskPreviewTone = 'good' | 'warn' | 'alert' | 'info';

const resolveSmartTaskPreviewTone = (status: DeferredObjectivePlanPreviewStatus): SmartTaskPreviewTone => {
  if (status === 'cannot_meet') return 'alert';
  if (status === 'at_risk') return 'warn';
  if (status === 'satisfied') return 'good';
  return 'info';
};

export type SmartTaskPreviewView = {
  deadlineAtMs: number;
  // When the task would run and be ready, formatted server-side in the Homey
  // timezone. Each form words it for its own context.
  whenLine: string;
  costLine: string | null;
  // Feasibility verdict (cannot finish / at risk / unavailable reason). Null
  // when the projection is an ordinary healthy estimate.
  verdictLine: string | null;
  verdictTone: SmartTaskPreviewTone;
  cannotFinish: boolean;
  caveat: string;
};

export const toSmartTaskPreviewView = (
  response: Extract<SettingsUiSmartTaskPreviewResponse, { ok: true }>,
  whenLine: string,
): SmartTaskPreviewView => ({
  deadlineAtMs: response.deadlineAtMs,
  whenLine,
  costLine: response.estimate.costEstimate !== null && response.estimate.costUnit
    ? formatDeadlineCostMetaLine({
      plannedTotalCost: response.estimate.costEstimate,
      deliveredCost: null,
      costUnit: response.estimate.costUnit,
    })
    : null,
  verdictLine: resolveSmartTaskPreviewStatusCopy(
    response.estimate.status,
    response.estimate.unavailableReason,
    response.estimate.budgetRole,
  ),
  verdictTone: resolveSmartTaskPreviewTone(response.estimate.status),
  cannotFinish: response.estimate.status === 'cannot_meet',
  caveat: CREATE_SMART_TASK_WIDGET_COPY.estimateCaveat,
});
