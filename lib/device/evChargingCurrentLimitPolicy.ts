import type {
  AssociatedCarSnapshot, CarConfirmation, EvChargingCurrentLimits,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { SteppedLoadWrite } from '../ports/steppedLoadWrite';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { EvChargingCurrentPolicy } from './evChargingCurrentLimitSettings';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { TransportSnapshotStore } from './transport/transportSnapshotStore';
import {
  buildEvTargetPowerCandidateProfile, isEvTargetPowerConfig, resolveEvTargetPowerPlannerProfile,
} from './targetPowerReachability';
import {
  hasUsableSteppedLoadLadder, isSteppedLoadOffStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';

/** Live identity belongs to the existing car-matching owner, never to a copied snapshot. */
export type ChargingCarIdentity = {
  getAssociatedCar(deviceId: string): AssociatedCarSnapshot | undefined;
  getCarConfirmation(deviceId: string): CarConfirmation | undefined;
};

/** An identified car's range overrides the charger's default charging range. */
export class EvChargingCurrentLimitPolicy {
  constructor(
    private readonly settings: Pick<DeviceControlSettings,
      'resolveEvCarCurrentLimits' | 'resolveEvChargerCurrentLimits'>,
    private readonly cars: ChargingCarIdentity,
    private readonly snapshots: TransportSnapshotStore,
  ) {}

  resolve(deviceId: string): EvChargingCurrentPolicy {
    const carId = this.cars.getAssociatedCar(deviceId)?.carId
      ?? this.cars.getCarConfirmation(deviceId)?.carId;
    if (carId !== undefined) {
      const carPolicy = this.settings.resolveEvCarCurrentLimits(carId);
      if (carPolicy.kind !== 'unrestricted') return carPolicy;
    }
    return this.settings.resolveEvChargerCurrentLimits(deviceId);
  }

  projectConfiguration(configuration: DeviceConfigurationRead): DeviceConfigurationRead {
    if (!configuration.isEvCharger) return configuration;
    const policy = this.resolve(configuration.id);
    if (policy.kind === 'unrestricted') return configuration;
    if (policy.kind === 'hold' || configuration.controlModel !== 'stepped_load') {
      return { ...configuration, carCurrentRangeUnavailable: true };
    }
    const targetPowerConfig = this.effectiveConfig(configuration.id, configuration.targetPowerConfig, policy.limits);
    if (!this.hasPhysicalCurrentRange(configuration.id, targetPowerConfig)) {
      return { ...configuration, targetPowerConfig, carCurrentRangeUnavailable: true };
    }
    const minimum = isEvTargetPowerConfig(targetPowerConfig)
      ? buildEvTargetPowerCandidateProfile(targetPowerConfig).steps.find((step) => step.planningPowerW > 0)
      : undefined;
    const profile = configuration.steppedLoadProfile;
    // An authored whole-amp minimum is an allowed command before it has been
    // observed. Keep the rest of the observation ladder intact: 32 A physically
    // reported while this car allows 25 A remains 32 A until corrected.
    const steppedLoadProfile = minimum && !profile.steps.some((step) => step.id === minimum.id)
      ? { ...profile, steps: [...profile.steps, minimum].sort((a, b) => a.planningPowerW - b.planningPowerW) }
      : profile;
    return { ...configuration, targetPowerConfig, steppedLoadProfile };
  }

  projectSwitchSnapshot(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const policy = this.resolve(snapshot.id);
    return policy.kind === 'limited'
      ? { ...snapshot, targetPowerConfig: this.effectiveConfig(snapshot.id, snapshot.targetPowerConfig, policy.limits) }
      : snapshot;
  }

  assertStartAllowed(snapshot: TransportDeviceSnapshot): void {
    const policy = this.resolve(snapshot.id);
    if (policy.kind === 'unrestricted') return;
    if (policy.kind === 'hold') throw new Error('The charging current limits are unavailable.');
    const config = this.effectiveConfig(snapshot.id, snapshot.targetPowerConfig, policy.limits);
    const profile = snapshot.steppedLoadProfile;
    if (!profile || !this.hasPhysicalCurrentRange(snapshot.id, config)
      || !hasUsableSteppedLoadLadder(resolveEvTargetPowerPlannerProfile({
        config, confirmedProfile: profile, nowMs: Date.now(),
      }))) throw new Error('No charging current is supported by the active range on this charger.');
  }

  /** A previously decided command must still fit the car identified at delivery. */
  assertStepAllowed(request: SteppedLoadWrite): void {
    if (isSteppedLoadOffStep(request.profile, request.desiredStepId)) return;
    const policy = this.resolve(request.deviceId);
    if (policy.kind === 'unrestricted') return;
    if (policy.kind === 'hold') throw new Error('The charging current limits are unavailable.');
    const snapshot = this.snapshots.getSnapshotByDeviceId(request.deviceId);
    if (!snapshot) throw new Error('The charger’s current-control configuration is unavailable.');
    const config = this.effectiveConfig(request.deviceId, snapshot.targetPowerConfig, policy.limits);
    if (request.planningCurrentA < config.currentLimits.minA || request.planningCurrentA > config.currentLimits.maxA
      || (config.max !== undefined && request.planningPowerW > config.max)
      || !this.hasPhysicalCurrentRange(request.deviceId, config)) {
      throw new Error('The requested charging current is outside the active charging range.');
    }
    const physical = snapshot.automaticPowerControl?.profile.steps.filter((step) => step.planningPowerW > 0);
    if (physical?.every((step) => step.planningCurrentA !== undefined)
      && !physical.some((step) => step.planningCurrentA === request.planningCurrentA)) {
      throw new Error('The requested charging current is not supported by this charger.');
    }
  }

  private hasPhysicalCurrentRange(deviceId: string, config: TargetPowerSteppedLoadConfig): boolean {
    const limits = config.currentLimits;
    if (!limits) return true;
    const active = this.snapshots.getSnapshotByDeviceId(deviceId)?.automaticPowerControl?.profile.steps
      .filter((step) => step.planningPowerW > 0);
    if (!active || active.some((step) => step.planningCurrentA === undefined)) return true;
    return active.some((step) => step.planningCurrentA !== undefined
      && step.planningCurrentA >= limits.minA && step.planningCurrentA <= limits.maxA
      && (config.max === undefined || !isEvTargetPowerConfig(config)
        || step.planningCurrentA * 230 * (config.preset === 'ev_charger_3_phase' ? 3 : 1) <= config.max));
  }

  private effectiveConfig(
    deviceId: string,
    config: TargetPowerSteppedLoadConfig | undefined,
    currentLimits: EvChargingCurrentLimits,
  ): TargetPowerSteppedLoadConfig & { currentLimits: EvChargingCurrentLimits } {
    const effective = { ...config, currentLimits };
    if (!isEvTargetPowerConfig(effective)) return effective;
    // The integration's complete native ladder is physical capability, separate
    // from the confirmed observation ladder and from the owner's Manual model.
    const physical = this.snapshots.getSnapshotByDeviceId(deviceId)?.automaticPowerControl?.profile;
    if (!physical) return effective;
    const activeSteps = physical.steps.filter((step) => step.planningPowerW > 0);
    if (activeSteps.every((step) => step.planningCurrentA !== undefined)) {
      const wattsPerAmp = 230 * (effective.preset === 'ev_charger_3_phase' ? 3 : 1);
      const currents = activeSteps.flatMap((step) => step.planningCurrentA === undefined
        ? [] : [step.planningCurrentA]).sort((a, b) => a - b);
      const maximumA = effective.max === undefined
        ? currentLimits.maxA : Math.min(currentLimits.maxA, Math.floor(effective.max / wattsPerAmp));
      const supported = currents.filter((current) => current >= currentLimits.minA && current <= maximumA);
      const resolvedLimits = supported.length > 0
        ? { minA: Math.min(...supported), maxA: Math.max(...supported) } : currentLimits;
      const physicalMaximumW = Math.max(...currents) * wattsPerAmp;
      return { ...effective, currentLimits: resolvedLimits, max: effective.max === undefined
        ? physicalMaximumW : Math.min(effective.max, physicalMaximumW) };
    }
    const physicalMaximumW = Math.max(...physical.steps.map((step) => step.planningPowerW));
    return { ...effective, max: effective.max === undefined
      ? physicalMaximumW : Math.min(effective.max, physicalMaximumW) };
  }
}
