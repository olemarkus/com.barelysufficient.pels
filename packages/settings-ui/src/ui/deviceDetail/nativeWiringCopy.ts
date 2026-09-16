/* User-facing copy for the settings UI's built-in device-control handoff. */

export const NATIVE_WIRING_FLOW_CONFLICT_TITLE = 'A Homey Flow already controls this device';

export const NATIVE_WIRING_FLOW_CONFLICT_BODY = 'PELS left built-in device control (the switch below) off so it '
  + 'does not fight your Flow. Your Flow keeps working as it does now. To switch, turn off only the action that '
  + 'controls this device, then turn on built-in device control below.';

export type NativeWiringFlowConflictNotice = {
  title: string;
  body: string;
};

export function nativeWiringFlowConflictNotice(flowName?: string): NativeWiringFlowConflictNotice {
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
