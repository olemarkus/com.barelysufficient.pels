/** How long a stepped-load Flow trigger has to be accepted before PELS reads it as unacknowledged. */
export const FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS = 10_000;

/** Whether the Flow trigger was accepted within {@link FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS}. */
export async function awaitFlowTriggerAcceptance(
    trigger: () => Promise<unknown> | unknown,
): Promise<'accepted' | 'timed_out'> {
    let acceptanceTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const triggerResult = Promise.resolve()
            .then(trigger)
            .then(() => 'accepted' as const);
        const timeoutResult = new Promise<'timed_out'>((resolve) => {
            acceptanceTimeout = setTimeout(() => resolve('timed_out'), FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS);
            acceptanceTimeout.unref();
        });
        return await Promise.race([triggerResult, timeoutResult]);
    } finally {
        if (acceptanceTimeout) clearTimeout(acceptanceTimeout);
    }
}
