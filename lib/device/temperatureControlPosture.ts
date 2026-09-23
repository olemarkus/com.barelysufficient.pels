import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import type { ResidualKwShedBehavior } from './deviceResidualKw';
import { getSteppedLoadLowestActiveStep } from '../utils/deviceControlProfiles';
import type {
  DecoratedDeviceSnapshot, TemperatureObservedProbe, TargetDeviceSnapshot, ThermalDirection,
} from '../../packages/contracts/src/types';
import type { ConfiguredShedBehavior } from '../../packages/shared-domain/src/settings/shedBehaviors';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isObserveOnlyRoleClassKey } from '../../packages/shared-domain/src/observeOnlyRole';
import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';
import type { DeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';

/**
 * The device's control posture, resolved once, here.
 *
 * The only place `commandAuthority` is SEEDED. Pure: the caller reads the
 * settings and passes them, so nothing above this layer classifies anything.
 * Power limiting is authority's standing term; decorators that know about other
 * authorities OR theirs on afterwards (`applyDeferredAdmissionToInput` for a
 * smart task), which is what replaced admission writing a user setting
 * mid-cycle.
 *
 * `capacityControlEnabled` is passed rather than rebuilt from `managed` and the
 * owner's Power-limit toggle, and that is load-bearing. It leads with
 * `!isObserveOnlyRoleDevice(id)` — the transport's ID-SET role membership —
 * while `resolveManagedState` returns `true` for exactly those devices. Deriving
 * the conjunction here would turn the id-set veto into a term that can SUPPLY
 * `managed: true`, so a device the id set still holds as a battery whose current
 * parse yields an ordinary class key could be granted authority off a stale
 * `controllable_devices` entry. The two vetoes are independent on purpose
 * (`managerParseDeviceFields.ts`: "no window where a present battery/solar
 * device ... enters the planner controllable/actuated") and both are kept.
 */
export function resolveDeviceControlPosture(
  device: DecoratedDeviceSnapshot,
  managed: boolean,
  capacityControlEnabled: boolean,
  startPolicy: DeviceStartPolicy,
): DeviceControlPosture {
  if (isObserveOnlyRoleClassKey(device.deviceClass)) {
    // The structural veto, keyed on the parse-time class key. A battery or panel
    // is tracked and never commanded, whatever the settings say. `managed` reads
    // the snapshot's own stamp because the managed FILTER must keep observing it.
    return { managed: device.managed !== false, commandAuthority: false };
  }
  return {
    managed,
    // Two standing grants, OR'd, then gated on the device having an axis at all.
    //
    // Power-limit control is the first: the owner opted the device into limiting
    // and resuming on whole-home usage.
    //
    // `pels_only` is the second, and it is the whole point of that policy. The
    // owner said this device runs when PELS starts it and not otherwise, which
    // is a grant of authority in its own right — and precisely in the case where
    // power-limit control is OFF, where PELS would otherwise hold no lever and
    // an unplanned start is absorbed as background usage. It is ANDed with
    // `managed` because an unmanaged device is ignored entirely, whatever else
    // the owner configured.
    //
    // The last two terms are the device's own axes. A thermostat whose
    // temperature control the owner switched off, with no binary or stepped
    // handle left, has nothing PELS could command. And a device with no power
    // reading has no power axis: limiting it, resuming it, starting it or
    // turning it on are all power decisions, which take a measured draw (owner
    // ruling 2026-09-23). Its setpoints still follow the temperature logic —
    // those writes never needed this authority — but PELS never switches it.
    commandAuthority: (capacityControlEnabled || (managed && startPolicy === 'pels_only'))
      && hasTemperaturePolicyPowerControl(device)
      && hasObservedMeasuredPower(device),
  };
}

/**
 * Whether the device has any axis PELS may limit on. The setpoint counts unless
 * the owner switched temperature control off ("Keep the new temperature") —
 * NOT when they chose "Save as current mode target": that policy switches off
 * the price and solar offsets (`temperatureAdjustmentsDisabled`), and limiting
 * by setpoint stays in force under it. One predicate, the same one
 * `allowsLimiting` answers at the shed-behaviour seam.
 */
export function hasTemperaturePolicyPowerControl(device: DecoratedDeviceSnapshot): boolean {
  return device.temperatureControlDisabled !== true
    || device.binaryControl !== undefined || isSteppedLoadSnapshot(device);
}

/**
 * The owner's configured shed behaviour resolved onto ONE runtime `ShedBehavior`
 * for this device, now.
 *
 * Two things decide the `set_temperature` arm, and both are answered here so
 * nothing downstream sees a second limit or a policy:
 *
 * - **Direction.** The configured entry carries a limit per direction; the
 *   device's current `thermalDirection` picks one — the floor while heating,
 *   the ceiling while cooling. Handing a cooling unit its heating floor would
 *   make the compressor work harder, the one outcome a shed must never have.
 * - **Policy.** "Keep the new temperature" (`external`) means PELS writes no
 *   setpoint at all, so the arm is denied there. Denial falls to the device's
 *   other axis — off if it has on/off, its lowest step if it is stepped. "Save
 *   as current mode
 *   target" is NOT a denial: limiting still applies under it, and a change the
 *   owner makes while the device is limited is drift the executor reconciles,
 *   not a new target (`ObservedTemperatureModeUpdates`).
 *
 * The device arrives as a THUNK because most calls answer without it, and
 * resolving it is not free: the caller's device view re-projects and
 * re-decorates on access, and this runs several times per device per plan
 * build (shed floors, candidates, restore, the silent-meter pass). Passed
 * eagerly it rebuilt the whole device list every time, for an argument usually
 * unread.
 */
export function resolveTemperaturePolicyShedBehavior(
  configured: ConfiguredShedBehavior,
  readDevice: () => DecoratedDeviceSnapshot | undefined,
  allowsLimiting: boolean,
  direction: ThermalDirection,
): ResidualKwShedBehavior {
  if (configured.action !== 'set_temperature') return configured;
  if (allowsLimiting) {
    return {
      action: 'set_temperature',
      temperature: direction === 'cooling' ? configured.coolingTemperature : configured.temperature,
    };
  }
  const device = readDevice();
  if (device && device.binaryControl === undefined && isSteppedLoadSnapshot(device)) return { action: 'set_step' };
  return { action: 'turn_off' };
}

export type ResidualKwForPlanDeviceShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_temperature'; temperature: number }
  | { action: 'set_step'; stepId: string };

/**
 * Project the owner's CONFIGURED shed behaviour onto the device it applies to.
 *
 * The configured value is a floor, not a decision: `set_step` carries no rung
 * (the producer never stores one), and `set_temperature` is denied outright when
 * the owner switched temperature control off or the device has no observed
 * temperature. This is the whole of that projection, and it is pure — the ctx
 * lookup stays at the `toPlanDevice` seam, so the fixture builders can ask the
 * SAME function rather than restating the two arms. A restated mirror already
 * dropped the denial arm once.
 */
export function resolveResidualShedBehavior(
  configured: ResidualKwShedBehavior,
  device: DecoratedDeviceSnapshot & TemperatureObservedProbe,
): ResidualKwForPlanDeviceShedBehavior {
  if (configured.action === 'set_temperature') {
    // The setpoint arm — and only it — is denied when the owner switched
    // temperature control off ("Keep the new temperature"). Relaxing this to
    // "the fence will catch it" would let a stale persisted setpoint shed reach
    // the planner: a stepped device routes its release through `shed_release`,
    // which would issue a `target` command the fence refuses under that policy,
    // leaving the device shed with no way back. (Under "Save as current mode
    // target" the fence admits the limit, and the arm is not denied.)
    // The first disjunct cannot decide anything in production:
    // `projectTemperatureDeniedDevice` (applied in `toPlanDevice.ts`) already blanks
    // `targets`/`temperature` and stamps `deviceType: 'onoff'` for a
    // temperature-disabled device before this runs. It is kept because fixture
    // callers reach this function directly, without that projection — so the
    // denial must hold here too rather than rely on a caller that may not exist.
    // `temperatureAdjustmentsDisabled` is deliberately NOT a term here: it says
    // the offsets are off, and limiting is not an offset.
    if (device.temperatureControlDisabled === true || device.temperature === undefined) {
      return resolveShedBehaviorWithoutTemperature(device);
    }
    return { action: 'set_temperature', temperature: configured.temperature };
  }
  if (configured.action === 'set_step') {
    // The rung is the device's own — a configured step id used to take
    // precedence here, but nothing ever wrote one.
    const stepId = isSteppedLoadSnapshot(device)
      ? getSteppedLoadLowestActiveStep(device.steppedLoadProfile)?.id
      : undefined;
    return stepId ? { action: 'set_step', stepId } : { action: 'turn_off' };
  }
  return { action: 'turn_off' };
}

function resolveShedBehaviorWithoutTemperature(
  device: DecoratedDeviceSnapshot,
): ResidualKwForPlanDeviceShedBehavior {
  if (device.binaryControl !== undefined) return { action: 'turn_off' };
  if (!isSteppedLoadSnapshot(device)) return { action: 'turn_off' };
  const lowestActiveStep = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  return lowestActiveStep
    ? { action: 'set_step', stepId: lowestActiveStep.id }
    : { action: 'turn_off' };
}


/** Stamp temperature permissions without changing the observed temperature facet. */
export function withTemperatureControlPolicy<T extends TargetDeviceSnapshot>(
  device: T,
  disabled: boolean,
  adjustmentsDisabled: boolean,
): T {
  return { ...device,
    temperatureControlDisabled: disabled ? true : undefined,
    temperatureAdjustmentsDisabled: adjustmentsDisabled ? true : undefined,
  };
}
