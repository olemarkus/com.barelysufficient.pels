import type { ResidualKwShedBehavior } from './deviceResidualKw';
import { getSteppedLoadLowestActiveStep } from '../utils/deviceControlProfiles';
import type {
  DecoratedDeviceSnapshot, TemperatureObservedProbe, TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isObserveOnlyRoleClassKey } from '../../packages/shared-domain/src/observeOnlyRole';
import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';

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
): DeviceControlPosture {
  if (isObserveOnlyRoleClassKey(device.deviceClass)) {
    // The structural veto, keyed on the parse-time class key. A battery or panel
    // is tracked and never commanded, whatever the settings say. `managed` reads
    // the snapshot's own stamp because the managed FILTER must keep observing it.
    return { managed: device.managed !== false, commandAuthority: false };
  }
  return {
    managed,
    // The second term is the device's own axis: a thermostat whose temperature
    // control the owner switched off, with no binary or stepped handle left, has
    // nothing PELS could command. This whole expression is the old merged
    // `controllable`, which is why every site that asked the old question reads
    // this member and behaviour is unchanged.
    commandAuthority: capacityControlEnabled && hasTemperaturePolicyPowerControl(device),
  };
}

export function hasTemperaturePolicyPowerControl(device: DecoratedDeviceSnapshot): boolean {
  return (device.temperatureAdjustmentsDisabled !== true && device.temperatureControlDisabled !== true)
    || device.binaryControl !== undefined || isSteppedLoadSnapshot(device);
}

/** Preserve the configured action unless following device targets removes its axis. */
export function resolveTemperaturePolicyShedBehavior<T extends { action: string }>(
  configured: T,
  devices: readonly DecoratedDeviceSnapshot[],
  deviceId: string,
  allowsAdjustments: boolean,
): T | { action: 'turn_off' } | { action: 'set_step' } {
  if (allowsAdjustments || configured.action !== 'set_temperature') return configured;
  const device = devices.find((candidate) => candidate.id === deviceId);
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
    // temperature control off. Relaxing this to "the fence will catch it" would
    // let a stale persisted setpoint shed reach the planner: a stepped device
    // routes its release through `shed_release`, which would issue a `target`
    // command the fence refuses, leaving the device shed with no way back.
    // The first disjunct cannot decide anything in production:
    // `projectTemperatureDeniedDevice` (applied in `toPlanDevice.ts`) already blanks
    // `targets`/`temperature` and stamps `deviceType: 'onoff'` for a
    // temperature-disabled device before this runs. It is kept because fixture
    // callers reach this function directly, without that projection — so the
    // denial must hold here too rather than rely on a caller that may not exist.
    if (device.temperatureControlDisabled === true || device.temperatureAdjustmentsDisabled === true
      || device.temperature === undefined) {
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
