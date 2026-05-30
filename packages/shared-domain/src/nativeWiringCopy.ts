/*
 * User-facing copy for the native-wiring (built-in device control) surfaces.
 *
 * Shared so runtime logging and the settings UI use the same wording
 * (per the "UI text shared with logs" convention). Intentionally plain
 * language: it never surfaces raw capability ids (e.g. `max_power_3000`) to
 * users — the conflict data decides when the notice shows, not its text.
 */

export const NATIVE_WIRING_FLOW_CONFLICT_TITLE = 'A Homey Flow already controls this device';

// Ties the notice to the visible "built-in device control" switch below it and
// names both ways forward: remove the Flow (PELS then controls it), or turn the
// switch on to override (PELS controls it directly, alongside the Flow).
export const NATIVE_WIRING_FLOW_CONFLICT_BODY = 'PELS left built-in device control (the switch below) off so it '
  + "does not fight your Flow. Remove that Flow to let PELS control this device, or turn the switch on to take over.";

export type NativeWiringFlowConflictNotice = {
  title: string;
  body: string;
};

// When a single named Flow is responsible, name it so the user knows exactly
// which Flow to remove. The producer only sets a name when exactly one Flow is
// the cause (see classifyFlowConflicts), so this never has to count Flows; an
// empty/absent name falls back to the generic copy.
export function nativeWiringFlowConflictNotice(flowName?: string): NativeWiringFlowConflictNotice {
  if (flowName !== undefined && flowName.length > 0) {
    return {
      title: `The Flow “${flowName}” already controls this device`,
      body: 'PELS left built-in device control (the switch below) off so it does not fight '
        + `your Flow “${flowName}”. Remove it to let PELS control this device, or turn the `
        + 'switch on to take over.',
    };
  }
  return {
    title: NATIVE_WIRING_FLOW_CONFLICT_TITLE,
    body: NATIVE_WIRING_FLOW_CONFLICT_BODY,
  };
}
