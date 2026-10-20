import type { NativeFlowConflicts } from '../flowApi/acceptedFlowConflictStore';

/**
 * Whether built-in device control runs, given the owner's choice and their
 * Homey Flows. One rule for every built-in control: the native stepped wiring
 * (Hoiax water heaters, Easee chargers) and the charging-current setup (Tesla,
 * Zaptec, Futurehome; `ChargingCurrentControl.routesBuiltIn`).
 *
 * PELS cannot stop a Flow. When a Flow writes the setting PELS would write
 * under built-in control, the device obeys whichever wrote last, so the two
 * override each other: a Flow that raises a charger's current can take the
 * house past its limit. Built-in control is therefore in effect only while no
 * Flow is known to write that setting. Until then the setting stays with the
 * Flow, exactly as with built-in control off.
 *
 * The owner's choice is kept, so built-in control resumes on its own once the
 * Flow no longer writes the setting. "Known" means the last Flow read PELS
 * accepted: an unreadable Flow list changes nothing. See
 * `notes/native-wiring/README.md` § "The conflict rule".
 */
export function isBuiltInControlInEffect(chosen: boolean, flowWritesSameSetting: boolean): boolean {
  return chosen && !flowWritesSameSetting;
}

/**
 * Native stepped wiring for one device: the owner's explicit entry in
 * `native_ev_wiring_devices` (true or false) when there is one, else the
 * conflict-gated auto-enable decision, held back while a Flow conflict is
 * known (`isBuiltInControlInEffect`).
 */
export function resolveNativeWiringEnabled(
  deviceId: string,
  ownerChoices: Readonly<Record<string, boolean>>,
  autoDecisions: Readonly<Record<string, boolean>>,
  flowConflicts: Readonly<NativeFlowConflicts>,
): boolean {
  const chosen = Object.prototype.hasOwnProperty.call(ownerChoices, deviceId)
    ? ownerChoices[deviceId] === true
    : autoDecisions[deviceId] === true;
  return isBuiltInControlInEffect(chosen, Object.prototype.hasOwnProperty.call(flowConflicts, deviceId));
}
