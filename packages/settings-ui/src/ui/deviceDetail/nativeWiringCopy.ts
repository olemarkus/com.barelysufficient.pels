/* User-facing copy for the settings UI's built-in device-control handoff. */

export type NativeWiringFlowConflictNotice = {
  title: string;
  body: string;
};

/** How the owner clears a conflicting Flow, shared by the notice and the recommendation. */
export function flowConflictHandoffStep(flowName: string | undefined): string {
  return flowName !== undefined && flowName.length > 0
    ? `disable the Flow “${flowName}” or delete its device-control action, then select “Check again”`
    : 'disable each conflicting Flow or delete its device-control action, then select “Check again”';
}

/**
 * The device-detail notice for a Flow that writes the setting built-in device
 * control would write. The runtime holds built-in control back while such a
 * Flow exists (`lib/device/builtInControlFlowGate.ts`), so the copy says that,
 * and why: PELS cannot stop a Flow, and two writers override each other.
 * `builtInChosen` is the owner's choice, kept while it is held back.
 */
export function nativeWiringFlowConflictNotice(
  flowName: string | undefined,
  builtInChosen: boolean,
): NativeWiringFlowConflictNotice {
  const named = flowName !== undefined && flowName.length > 0;
  const flowReference = named ? `The Flow “${flowName}”` : 'A Homey Flow';
  const handoff = flowConflictHandoffStep(flowName);
  if (builtInChosen) {
    return {
      title: 'Built-in device control is paused',
      body: `${flowReference} controls the same setting, and PELS cannot stop a Flow. `
        + 'The two would override each other, so PELS leaves the setting to the Flow for now. '
        + `To use built-in device control, ${handoff}. It resumes on its own.`,
    };
  }
  return {
    title: named ? `The Flow “${flowName}” controls this device` : 'A Homey Flow controls this device',
    body: 'Your Flow keeps working as it does now. Built-in device control stays off while a Flow '
      + 'controls the same setting, because the two would override each other. '
      + `To switch, ${handoff}, and turn on built-in device control below.`,
  };
}
