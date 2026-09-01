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
const buildSteppedLoadReportedState = (params: {
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
const hasSteppedLoadReportChanged = (
  previous: SteppedLoadReportedRuntimeState | undefined,
  next: SteppedLoadReportedRuntimeState,
): boolean => {
  if (!previous) return true;
  return previous.stepId !== next.stepId || previous.planningPowerW !== next.planningPowerW;
};

/**
 * Observer-owned store of the last Flow-reported rung per device.
 *
 * The map used to live in the executor's `DeviceControlRuntimeState`, beside
 * the commanded axis. That put an OBSERVATION — what the device attested — in a
 * struct whose other members are all "what PELS asked for", and left the
 * executor answering, on the observer's behalf, whether a device had ever
 * reported. The two axes stay apart because they answer different questions,
 * and the layer that owns each answer is the layer that owns the question
 * (`lib/executor/AGENTS.md`; the module docblock above).
 *
 * `record` returns whether the report says anything new, because "is this news"
 * is a question about observations and is answered here — the executor reacts
 * to the verdict rather than recomputing it.
 */
export class SteppedReportedStepStore {
  private readonly byDeviceId = new Map<string, SteppedLoadReportedRuntimeState>();

  /** The device's last admitted Flow report, or `undefined` if it never reported. */
  get(deviceId: string): SteppedLoadReportedRuntimeState | undefined {
    return this.byDeviceId.get(deviceId);
  }

  /**
   * Admit a report and say whether it is news. The caller has already checked
   * that `stepId` names a rung on the device's ladder — that is a question
   * about the configured profile, which this layer does not hold.
   */
  record(params: {
    deviceId: string;
    stepId: string;
    reportedAtMs: number;
    planningPowerW?: number;
  }): 'changed' | 'unchanged' {
    const { deviceId, ...report } = params;
    const previous = this.byDeviceId.get(deviceId);
    const next = buildSteppedLoadReportedState(report);
    this.byDeviceId.set(deviceId, next);
    return hasSteppedLoadReportChanged(previous, next) ? 'changed' : 'unchanged';
  }

  /** Whether any device has reported at all. */
  hasAny(): boolean {
    return this.byDeviceId.size > 0;
  }

  /** Forget the report: the device's native wiring is authoritative instead. */
  clear(deviceId: string): void {
    this.byDeviceId.delete(deviceId);
  }
}

export const createSteppedReportedStepStore = (): SteppedReportedStepStore => (
  new SteppedReportedStepStore()
);
