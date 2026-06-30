import { incPerfCounters } from '../lib/utils/perfCounters';
import type { FlowCardDeps } from './registerFlowCards';

export function requestPlanRebuildFromFlow(deps: FlowCardDeps, source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.flow_total',
    `plan_rebuild_requested.flow.${source}_total`,
  ]);
  deps.rebuildPlan(source);
}
