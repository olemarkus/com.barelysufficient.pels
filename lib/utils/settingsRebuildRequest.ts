import { incPerfCounters } from './perfCounters';

export function recordSettingsRebuildRequest(source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.settings_total',
    `plan_rebuild_requested.settings.${source}_total`,
  ]);
}
