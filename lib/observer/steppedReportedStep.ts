/**
 * The stepped device's own attestation of which rung it is on, as reported over
 * Flow.
 *
 * This is an OBSERVATION and nothing else: what the device says, stamped with
 * when it said it. It lives here rather than beside the command axis
 * (`lib/executor/steppedCommandState.ts`) because the two answer different
 * questions — what PELS asked for versus what the device attests — and the
 * layer that owns each answer is the layer that owns the question. The executor
 * reconciles the two; it does not own this half.
 *
 * Native stepped reports do not come through here. Those arrive as ordinary
 * capability observations and reach consumers via the transport snapshot's
 * `reportedStepId`; this store exists for the flow-driven devices, whose reports
 * have no capability to land on.
 *
 * `source: 'flow'` is a single-valued discriminant on purpose: it is what makes
 * a later native/other source an additive union member rather than a silent
 * reinterpretation of existing entries.
 */
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';

export type SteppedLoadReportedRuntimeState = {
  capabilityId: typeof PELS_MEASURE_STEP_CAPABILITY_ID;
  stepId: string;
  updatedAtMs: number;
  source: 'flow';
  planningPowerW?: number;
};

/**
 * Build the observation record for a flow-reported rung.
 *
 * Step VALIDITY is not decided here — whether `stepId` names a rung on the
 * device's ladder is a question about the configured profile, which this layer
 * does not hold. The caller admits or rejects the report first and only records
 * what it admitted.
 */
export const buildSteppedLoadReportedState = (params: {
  stepId: string;
  reportedAtMs: number;
  planningPowerW?: number;
}): SteppedLoadReportedRuntimeState => ({
  capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
  stepId: params.stepId,
  updatedAtMs: params.reportedAtMs,
  source: 'flow',
  ...(params.planningPowerW !== undefined ? { planningPowerW: params.planningPowerW } : {}),
});

/**
 * Whether a newly admitted report says anything the previous one did not.
 *
 * Absence of a previous report is a change: the first thing a device says is
 * news. Power is compared alongside the rung because a same-rung report at a
 * different power is the target-power probe's evidence, and collapsing it to
 * "unchanged" would drop the observation the probe is waiting on.
 */
export const hasSteppedLoadReportChanged = (
  previous: SteppedLoadReportedRuntimeState | undefined,
  next: SteppedLoadReportedRuntimeState,
): boolean => {
  if (!previous) return true;
  return previous.stepId !== next.stepId || previous.planningPowerW !== next.planningPowerW;
};
