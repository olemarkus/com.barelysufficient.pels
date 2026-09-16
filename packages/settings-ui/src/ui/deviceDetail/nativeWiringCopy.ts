/* User-facing copy for the settings UI's built-in device-control handoff. */

export const NATIVE_WIRING_FLOW_CONFLICT_TITLE = 'A Homey Flow already controls this device';

export const NATIVE_WIRING_FLOW_CONFLICT_BODY = 'PELS left built-in device control (the switch below) off so it '
  + 'does not fight your Flow. Your Flow keeps working as it does now. To switch, turn off only the action that '
  + 'controls this device, then turn on built-in device control below.';

export type NativeWiringFlowConflictNotice = {
  title: string;
  body: string;
};

export function nativeWiringFlowConflictNotice(
  flowName: string | undefined,
  nativeControlEnabled: boolean,
): NativeWiringFlowConflictNotice {
  if (nativeControlEnabled) {
    const flowReference = flowName ? `the Flow “${flowName}”` : 'a Homey Flow';
    return {
      title: 'Built-in device control and a Flow control the same setting',
      body: `Built-in device control is on, and ${flowReference} can still write the same setting. `
        + 'They may override each other. Turn off only the conflicting Flow action to use built-in control, '
        + 'or turn off built-in control to keep using your Flow.',
    };
  }
  if (flowName !== undefined && flowName.length > 0) {
    return {
      title: `The Flow “${flowName}” already controls this device`,
      body: 'PELS left built-in device control (the switch below) off so it does not fight '
        + `your Flow “${flowName}”. Your Flow keeps working as it does now. To switch, turn off `
        + 'only the action that controls this device, then turn on built-in device control below.',
    };
  }
  return {
    title: NATIVE_WIRING_FLOW_CONFLICT_TITLE,
    body: NATIVE_WIRING_FLOW_CONFLICT_BODY,
  };
}
