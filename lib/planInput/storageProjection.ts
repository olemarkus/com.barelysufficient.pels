import { isBatteryPowerLimitEnabled } from '../../packages/shared-domain/src/settings/batteryPowerLimit';
import type {
  PlanInputProjectionSource, StorageClusterFields, ToPlanDeviceInput, ToPlanDeviceOptions,
} from './planInputDeviceTypes';

const NO_STORAGE_CLUSTER: StorageClusterFields = {};

/**
 * A home battery's storage cluster (`StoragePlanInputKind`), or none when the
 * plan has no lever on it this cycle. Found by presence, never by class: the
 * home's battery control owner must read a setpoint surface for it (Main only:
 * a meter area's binding is `none`).
 *
 * A battery whose own signed power is observed, and which Homey does not report
 * unavailable, is `observed`. One PELS holds a claim on but cannot read is
 * `missing`, so the planner can keep or release the hold rather than lose it
 * silently; one it does not hold and cannot read has no lever at all.
 *
 * A battery the owner reads no setpoint surface on (PELS can only observe it)
 * has no lever either, but one read this cycle is `watched`: its signed power
 * alone, so its discharge counts against surplus devices. Managed is not
 * asked here: a Managed-off battery, of either kind, is dropped by the plan's
 * managed filter (`isRuntimePlannedPlanDevice`) and never reaches the plan.
 *
 * The delivery and charge ceilings are the owner's resolved ones, so the
 * planner reads one number for each: the range, or less once an increase
 * plateaued short of it. Power-limit control is the battery's own gate on
 * `controllable_devices` (`isBatteryPowerLimitEnabled`), never a load's
 * command authority.
 */
export const resolveStorageCluster = (
  source: PlanInputProjectionSource,
  device: ToPlanDeviceInput,
  options: ToPlanDeviceOptions,
): StorageClusterFields => {
  if (options.storage.kind === 'none') return NO_STORAGE_CLUSTER;
  const { owner } = options.storage;
  const control = owner.readControl(device.id);
  const power = device.batteryPower;
  if (control.kind === 'none') {
    // Only a home battery carries `batteryPower`.
    return device.available && power !== undefined
      ? { storage: { reading: 'watched', signedPowerW: power.signedW } }
      : NO_STORAGE_CLUSTER;
  }
  if (!device.available || power === undefined) {
    return control.claimHeld
      ? { storage: {
        reading: 'missing', claimHeld: true, admissible: control.admissible, handBackDeferred: control.handBackDeferred,
      } }
      : NO_STORAGE_CLUSTER;
  }
  return {
    storage: {
      reading: 'observed',
      range: control.range,
      handBackDeferred: control.handBackDeferred,
      signedPowerW: power.signedW,
      claimHeld: control.claimHeld,
      admissible: control.admissible,
      powerLimitControl: isBatteryPowerLimitEnabled(source.getControllableDevices(), device.id),
      verdict: control.verdict,
      deliveryCeilingW: control.deliveryCeilingW,
      chargeCeilingW: control.chargeCeilingW,
    },
  };
};
