// Conservative-high bootstrap kWh-per-percent for EV SoC objectives without a
// learned profile yet. Lives in shared-domain so both the planner
// (`lib/objectives/deferredObjectives/diagnosticsBridge.ts`) and the settings UI
// can reference the same value when labelling the bootstrap rate. Over-booking
// is harmless (the device stops at target SoC) but under-booking risks
// missing the deadline; ~100 kWh covers the upper end of consumer EVs.
export const BOOTSTRAP_EV_SOC_KWH_PER_PERCENT = 1.0;
