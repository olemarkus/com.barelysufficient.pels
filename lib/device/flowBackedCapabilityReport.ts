/**
 * What one flow-backed capability report actually did to observed device state,
 * and what therefore needs to happen next.
 *
 * Declared with the device layer because the verdict is the device layer's:
 * `FlowBackedDeviceState` produces it. `lib/app/appContext.ts` re-exports it so
 * existing importers keep their import site — one declaration, not two.
 */
export type FlowBackedCapabilityReportOutcome = {
  kind: 'state_changed' | 'freshness_only' | 'noop';
  valueChanged: boolean;
  freshnessAdvanced: boolean;
  refreshSnapshot: boolean;
  rebuildPlan: boolean;
};
