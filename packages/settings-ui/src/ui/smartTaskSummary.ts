import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { deadlineLabels } from '../../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import { SMART_TASK_LIST_ROW_LABELS } from '../../../shared-domain/src/smartTaskCopy/listCopy.ts';
import { formatSmartTaskGoalValue } from '../../../shared-domain/src/smartTaskCopy/valueFormat.ts';
import { resolveObjectiveTargetValue } from '../../../shared-domain/src/deferredObjectiveValues.ts';
import { formatSmartTaskListDateTime } from '../../../shared-domain/src/deferredPlanHistory.ts';
import { resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';

/** An open Smart task in one line, as the device page's Smart task box states it: its goal and ready-by time. */
export const formatOpenSmartTaskLine = (entry: DeferredObjectiveSettingsEntry): string => {
  const goal = formatSmartTaskGoalValue(resolveObjectiveTargetValue(entry), deadlineLabels(entry.kind).targetUnit);
  const readyBy = formatSmartTaskListDateTime(entry.deadlineAtMs, resolveBrowserTimeZone());
  return `${SMART_TASK_LIST_ROW_LABELS.target} ${goal} · ${SMART_TASK_LIST_ROW_LABELS.readyBy} ${readyBy}`;
};
