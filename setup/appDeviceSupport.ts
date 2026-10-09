import type Homey from 'homey';
import type { DeviceSurfaces } from '../packages/contracts/src/deviceSurfaces';
import { isBooleanMap } from '../lib/utils/appTypeGuards';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES } from '../lib/utils/settingsKeys';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../packages/shared-domain/src/targetCapabilities';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { UnrankedPlanInputDevice } from './appInit/toPlanDevice';
import {
  enforceTemperatureWithoutOnOffOvershootBehaviors,
  type ResolveOperatingModeForDevice,
} from './temperatureShedFloorDefaults';
import type { ModeTargetDevice } from '../packages/shared-domain/src/modeCatalogResolution';

export type { ResolveOperatingModeForDevice };

type StructuredEventEmitter = (event: Record<string, unknown>) => void;

type BooleanMap = Record<string, boolean>;

function parseBooleanMap(value: unknown): BooleanMap {
  return isBooleanMap(value) ? value : {};
}

// Filter is active iff at least one device is explicitly opted-in (`true`).
// Explicit `false` keys must NOT activate the filter on their own — otherwise a
// fresh-install user would flip from "all devices visible" to "only the
// explicit-true devices visible" merely because settings contain opt-outs.
export function isManagedFilterActive(managedDevices: BooleanMap): boolean {
  return Object.values(managedDevices).some((value) => value === true);
}

// The SINGLE definition of "is this device in the runtime-planned set" — the
// set the plan cycle actually evaluates. The plan service projects the snapshot,
// keeps the devices the plan can act on, then applies this predicate (see
// `buildHomePlanDevices`),
// so any consumer that needs to know whether a device will be planned (the
// create-smart-task candidate list AND create-time validation) MUST use this
// exact predicate. Otherwise a
// `managed: false` device can slip into the runtime snapshot when the managed
// filter is inactive (no device explicitly opted-in) yet be dropped by the
// planner — it would be offered/persisted but never planned or controlled.
//
// TWO SHAPES, ONE RULE. A raw snapshot carries an optional `managed`; a plan
// device carries the producer-resolved `control.managed`. Both ask the same
// question, so both go through `plannedFromManagedFlag` below rather than
// spelling the comparison twice — the header above demands the consumers stay in
// step, and two expressions of one rule is how that stops being true.
//
// In production `managed` is always resolved: the transport asks
// `resolveManagedState`, which answers a boolean for every device (an ordinary
// load with no `managed_devices` entry reads as not managed, a battery follows
// its Managed toggle, a panel is always managed). So `!== false` and `=== true`
// agree there; `undefined` only reaches this from a parse with no managed source
// (a fixture), which it treats as planned.
const plannedFromManagedFlag = (managed: boolean | undefined): boolean => managed !== false;

export function isRuntimePlannedDevice(device: { managed?: boolean }): boolean {
  return plannedFromManagedFlag(device.managed);
}

/** Plan-device form of {@link isRuntimePlannedDevice}; same rule, resolved shape. */
export function isRuntimePlannedPlanDevice(device: { control: { managed: boolean } }): boolean {
  return plannedFromManagedFlag(device.control.managed);
}

export function seedTemperatureShedFloorDefaults(params: {
  snapshot: DeviceSurfaces[];
  settings: Homey.App['homey']['settings'];
  debugStructured: StructuredEventEmitter;
  /**
   * Per-device active-mode resolution for the overshoot default seed (a
   * sub-home member's default must follow ITS home's mode, and an `unavailable`
   * outcome skips the seed instead of writing one under the global mode).
   */
  resolveOperatingModeForDevice: ResolveOperatingModeForDevice;
}): void {
  const { snapshot, settings, debugStructured, resolveOperatingModeForDevice } = params;
  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const controllable = parseBooleanMap(settings.get(CONTROLLABLE_DEVICES) as unknown);

  const shedBehaviorUpdated = enforceTemperatureWithoutOnOffOvershootBehaviors({
    settings,
    snapshot,
    managed,
    controllable,
    resolveOperatingModeForDevice,
  });

  if (shedBehaviorUpdated > 0) {
    debugStructured({ event: 'temperature_shedding_enforced', deviceCount: shedBehaviorUpdated });
  }
}

/**
 * The devices the mode-target fill pass (`ModeDeviceTargetFill`,
 * `lib/home/modeDeviceTargetFill.ts`) may write a target for: every device the
 * planner plans that has a setpoint PELS holds.
 *
 * Takes PLAN devices, not the snapshot the settings UI reads. The question here
 * — "what setpoint does PELS hold this device at" — is a control question, and
 * the two views answer differently on purpose: a device whose owner switched
 * temperature control off is still a temperature device to the UI (that is what
 * renders the toggle and the saved targets beneath it) and is NOT one to
 * control. Consuming the planner's type is what keeps this projection from
 * having a concept of the flag at all.
 *
 * It stays outside `lib/home` because both of its tests belong to other owners:
 * the planner's temperature narrowing (`isTemperaturePlanDevice`), which
 * `no-home-to-peer` keeps out of the home domain, and the planned-set predicate
 * above.
 */
export function listModeTargetFillDevices(
  devices: readonly UnrankedPlanInputDevice[],
): Array<ModeTargetDevice & { name: string }> {
  return devices
    .filter(isRuntimePlannedPlanDevice)
    .flatMap(buildModeTargetProbe);
}

/**
 * One device's facts for the resolver, or nothing if it has no setpoint to be
 * told.
 *
 * `isTemperaturePlanDevice` is the whole test — the same one the planner uses —
 * and it already answers correctly for BOTH reasons a device might have none: no
 * `target_temperature` capability, or an owner who switched temperature control
 * off, which `toPlanDevice` resolved away before this pass ever saw the device.
 *
 * The setpoint is normalized to the device's own min/max/step, so what gets
 * persisted is a value the device can actually hold.
 */
function buildModeTargetProbe(device: UnrankedPlanInputDevice): Array<ModeTargetDevice & { name: string }> {
  if (!isTemperaturePlanDevice(device)) return [];
  const normalized = normalizeTargetCapabilityValue({
    target: getPrimaryTargetCapability(device.targets),
    value: device.currentTarget,
  });
  // Guaranteed finite by the observer's atomic temperature facet, so the only
  // way this fails is a capability whose bounds cannot hold the reading.
  if (!Number.isFinite(normalized)) return [];
  return [{ id: device.id, name: device.name, heldSetpointC: normalized }];
}
