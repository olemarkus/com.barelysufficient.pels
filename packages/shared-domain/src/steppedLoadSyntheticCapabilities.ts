export const PELS_MEASURE_STEP_CAPABILITY_ID = 'pels_measure_step' as const;
export const PELS_TARGET_STEP_CAPABILITY_ID = 'pels_target_step' as const;

/**
 * Transport channel used to issue a stepped-load step request. `native_capability`
 * means a direct Homey capability write; `flow` means a flow trigger card.
 */
export type SteppedLoadStepRequestTransport = 'native_capability' | 'flow';

/**
 * Result of a stepped-load step request. `requested: false` indicates the
 * device did not accept the request (e.g. profile rejected the step); the
 * `transport` field carries the channel actually used when the request was
 * issued.
 */
export type SteppedLoadStepRequestResult =
    | { requested: false }
    | { requested: true; transport: SteppedLoadStepRequestTransport };
