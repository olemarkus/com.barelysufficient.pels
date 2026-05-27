// Producer adapter that assembles the revision-log row array + summary
// shape in one call so `buildReadyPayload` binds two fields from one source.
// Producer-side resolution per `feedback_layering_resolution_in_producer.md`
// — the view never composes rows + summary itself.

import {
  buildActivePlanRevisionLog,
  buildActivePlanRevisionLogSummary,
  type ActivePlanRevisionLogRow,
  type ActivePlanRevisionLogSummary,
} from '../../../shared-domain/src/activePlanRevisionLog.ts';
import { resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveSettingsKind } from '../../../contracts/src/deferredObjectiveSettings.ts';

export type RevisionPanelFeed = {
  rows: ActivePlanRevisionLogRow[];
  summary: ActivePlanRevisionLogSummary;
};

export const buildRevisionPanelFeed = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  history: readonly DeferredObjectiveActivePlanRevisionV1[] | undefined;
  kind: DeferredObjectiveSettingsKind;
}): RevisionPanelFeed => {
  const rows = buildActivePlanRevisionLog({
    latest: params.latest,
    history: params.history,
    timeZone: resolveBrowserTimeZone(),
    kind: params.kind,
  });
  const summary = buildActivePlanRevisionLogSummary({
    latest: params.latest,
    history: params.history,
    rows,
  });
  return { rows, summary };
};
