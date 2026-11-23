import type {
  AssociatedCarSnapshot, CarConfirmation, ChargingInstallation, EvChargingCurrentLimits,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { SteppedLoadWrite } from '../ports/steppedLoadWrite';
import type { EvChargingCurrentDiagnostics, EvChargingCurrentSource } from '../ports/evChargingCurrentDiagnostics';
import type { HomeyDeviceLike } from '../utils/types';
import type { CapabilityWrite } from './deviceAdapter';
import { resolveChargingCurrentAdapter } from './chargingCurrentAdapter';
import type { ChargingCurrentControl } from './chargingCurrentControl';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { EvChargingCurrentPolicy } from './evChargingCurrentLimitSettings';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { TransportSnapshotStore } from './transport/transportSnapshotStore';
import {
  buildEvTargetPowerCandidateProfile, isEvTargetPowerConfig, resolveEvTargetPowerPlannerProfile,
} from './targetPowerReachability';
import {
  hasUsableSteppedLoadLadder, isSteppedLoadOffStep, isSteppedLoadStepOff,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { resolveEvChargeAction } from '../../packages/shared-domain/src/evPlugState';
import { chargingLadderCarriesCurrent } from '../../packages/shared-domain/src/settings/evChargingCurrentLimits';

/** Live identity belongs to the existing car-matching owner, never to a copied snapshot. */
export type ChargingCarIdentity = {
  getAssociatedCar(deviceId: string): AssociatedCarSnapshot | undefined;
  getCarConfirmation(deviceId: string): CarConfirmation | undefined;
};

type InstallationCurrent = Pick<ChargingCurrentControl,
  'chargingInstallation' | 'installationLevelW' | 'installationWattsPerAmp'>;

type InstallationRange =
  | { kind: 'unrestricted' }
  | { kind: 'hold' }
  | { kind: 'limited'; limits: EvChargingCurrentLimits; wattsPerAmp: number };

type InstallationClaimPreparation = { kind: 'ready' } | { kind: 'blocked' } | { kind: 'prepare'; watts: number };

function isWithinInstallationRange(
  watts: number | undefined, range: Extract<InstallationRange, { kind: 'limited' }>,
): boolean {
  return watts !== undefined && watts >= Math.round(range.limits.minA * range.wattsPerAmp)
    && watts <= Math.round(range.limits.maxA * range.wattsPerAmp);
}

/** An identified car's range overrides the charger's default charging range. */
export class EvChargingCurrentLimitPolicy {
  constructor(
    private readonly settings: Pick<DeviceControlSettings,
      'resolveEvCarCurrentLimits' | 'resolveEvChargerCurrentLimits'>,
    private readonly cars: ChargingCarIdentity,
    private readonly snapshots: TransportSnapshotStore,
    private readonly installations: InstallationCurrent,
  ) {}

  resolve(deviceId: string): EvChargingCurrentPolicy {
    return this.resolveWithSource(deviceId).policy;
  }

  private resolveWithSource(deviceId: string): { policy: EvChargingCurrentPolicy; source: EvChargingCurrentSource } {
    const associatedCar = this.cars.getAssociatedCar(deviceId);
    const carId = associatedCar?.carId ?? this.cars.getCarConfirmation(deviceId)?.carId;
    if (carId !== undefined) {
      const carPolicy = this.settings.resolveEvCarCurrentLimits(carId);
      if (carPolicy.kind !== 'unrestricted') {
        return { policy: carPolicy, source: associatedCar ? 'associated_car' : 'confirmed_car' };
      }
    }
    return { policy: this.settings.resolveEvChargerCurrentLimits(deviceId), source: 'charger' };
  }

  /**
   * Any connected car may take the entire assignment as its peers pause.
   * Paused cars remain eligible for a later resume at the same assignment.
   */
  private installationRange(installation: ChargingInstallation): InstallationRange {
    const ranges = installation.memberIds
      .filter((id) => this.mayTakeInstallationCurrent(id))
      .map((id) => this.resolve(id));
    if (ranges.some(({ kind }) => kind === 'hold')) return { kind: 'hold' };
    const limits = ranges.flatMap((range) => range.kind === 'limited' ? [range.limits] : []);
    if (!limits.length) return { kind: 'unrestricted' };
    const minA = Math.max(...limits.map((range) => range.minA));
    const maxA = Math.min(...limits.map((range) => range.maxA));
    const wattsPerAmp = this.installations.installationWattsPerAmp(installation.mainId);
    if (minA > maxA || wattsPerAmp === undefined) return { kind: 'hold' };
    const range = { kind: 'limited' as const, limits: { minA, maxA }, wattsPerAmp };
    const profile = this.snapshots.getSnapshotByDeviceId(installation.mainId)?.steppedLoadProfile;
    return profile?.steps.some((step) => isWithinInstallationRange(step.planningPowerW, range))
      ? range : { kind: 'hold' };
  }

  private mayTakeInstallationCurrent(deviceId: string): boolean {
    const state = this.snapshots.getSnapshotByDeviceId(deviceId)?.evChargingState;
    if (state === undefined) return true;
    const action = resolveEvChargeAction(state);
    return action !== 'blocked' && action !== 'offer' && state !== 'plugged_in_car_stopped';
  }

  private projectInstallationRange(
    configuration: DeviceConfigurationRead, installation: ChargingInstallation,
  ): DeviceConfigurationRead {
    const range = this.installationRange(installation);
    if (range.kind === 'unrestricted') return configuration;
    if (range.kind === 'hold') return { ...configuration, carCurrentRangeUnavailable: true };
    if (installation.role !== 'main' || configuration.controlModel !== 'stepped_load') return configuration;
    const { steppedLoadProfile, targetPowerConfig } = configuration;
    const steps = steppedLoadProfile.steps.map((step) => ({
      ...step, planningCurrentA: step.planningPowerW / range.wattsPerAmp,
    }));
    const profile = { ...steppedLoadProfile, steps };
    const limits = { ...targetPowerConfig, currentLimits: range.limits };
    const usable = hasUsableSteppedLoadLadder(resolveEvTargetPowerPlannerProfile({
      config: limits, confirmedProfile: profile, nowMs: Date.now(),
    }));
    return {
      ...configuration, steppedLoadProfile: profile, targetPowerConfig: limits,
      ...(!usable ? { carCurrentRangeUnavailable: true } : {}),
    };
  }

  private assertInstallationCurrent(installation: ChargingInstallation, watts: number | undefined): void {
    const range = this.installationRange(installation);
    if (range.kind === 'unrestricted') return;
    if (range.kind === 'limited' && isWithinInstallationRange(watts, range)) return;
    throw new Error('The installation current is outside the active charging ranges.');
  }

  /** An out-of-range retained target must be replaced before its mode is claimed. */
  prepareInstallationClaim(deviceId: string): InstallationClaimPreparation {
    const installation = this.installations.chargingInstallation(deviceId);
    if (!installation) return { kind: 'ready' };
    const range = this.installationRange(installation);
    if (range.kind === 'unrestricted') return { kind: 'ready' };
    if (range.kind === 'hold') return { kind: 'blocked' };
    const retained = this.snapshots.getTrackedRawDevice(deviceId)?.capabilitiesObj.target_power?.value;
    if (typeof retained !== 'number' || !Number.isFinite(retained)) return { kind: 'blocked' };
    if (retained === 0 || isWithinInstallationRange(retained, range)) return { kind: 'ready' };
    const step = this.snapshots.getSnapshotByDeviceId(deviceId)?.steppedLoadProfile?.steps
      .find((candidate) => isWithinInstallationRange(candidate.planningPowerW, range));
    return step ? { kind: 'prepare', watts: step.planningPowerW } : { kind: 'blocked' };
  }

  /** Direct capability writes must obey the same range as planner step writes. */
  assertInstallationCapability(
    deviceId: string, raw: HomeyDeviceLike | undefined, write: CapabilityWrite,
  ): void {
    const installation = this.installations.chargingInstallation(deviceId);
    if (!installation || !raw) return;
    if (write.capabilityId === 'target_power' && typeof write.value === 'number' && write.value > 0) {
      this.assertInstallationCurrent(installation, write.value);
      return;
    }
    if (write.capabilityId === 'target_power_mode' && write.value === 'homey') {
      this.assertInstallationModeClaim(installation, raw);
      return;
    }
    const binding = resolveChargingCurrentAdapter(raw)?.current;
    if (binding?.kind === 'capability' && write.capabilityId === binding.capabilityId
      && typeof write.value === 'number') {
      const wattsPerAmp = this.installations.installationWattsPerAmp(installation.mainId);
      this.assertInstallationCurrent(installation, wattsPerAmp && write.value * wattsPerAmp);
    }
  }

  private assertInstallationModeClaim(installation: ChargingInstallation, raw: HomeyDeviceLike): void {
    const retained = raw.capabilitiesObj.target_power?.value;
    if (retained !== 0) {
      this.assertInstallationCurrent(installation, typeof retained === 'number' ? retained : undefined);
    }
  }

  /** Capture the projected configuration returned by DeviceConfigurationStore.get. */
  describe(configuration: DeviceConfigurationRead, nowMs: number): EvChargingCurrentDiagnostics | undefined {
    if (configuration.controlModel !== 'stepped_load') return undefined;
    const installation = this.installations.chargingInstallation(configuration.id);
    if (!installation && !boundsChargingCurrent(configuration)) return undefined;
    const selection = installation
      ? { policy: this.installationRange(installation), source: 'installation' as const }
      : this.resolveWithSource(configuration.id);
    const { policy, source } = selection;
    if (policy.kind === 'hold') return { kind: 'hold', cause: 'limits_unavailable', source };
    const plannerSteps = resolveEvTargetPowerPlannerProfile({
      config: configuration.targetPowerConfig, confirmedProfile: configuration.steppedLoadProfile, nowMs,
    }).steps.filter((step) => !isSteppedLoadStepOff(step));
    if (policy.kind === 'unrestricted') {
      return { kind: 'unrestricted', source: installation ? 'installation' : 'charger', plannerSteps };
    }
    const effectiveLimits = configuration.targetPowerConfig?.currentLimits;
    if (!effectiveLimits) throw new Error('Projected charging current limits are unavailable.');
    const held = configuration.carCurrentRangeUnavailable === true || plannerSteps.length === 0;
    return {
      ...(held ? { kind: 'hold', cause: 'no_supported_current' } as const : { kind: 'limited' } as const), source,
      selectedLimits: policy.limits, effectiveLimits, plannerSteps: held ? [] : plannerSteps,
    };
  }

  projectConfiguration(configuration: DeviceConfigurationRead): DeviceConfigurationRead {
    const installation = this.installations.chargingInstallation(configuration.id);
    if (installation) return this.projectInstallationRange(configuration, installation);
    // An on/off charger or a published watt ladder has no current to bound,
    // so a range never holds it.
    if (configuration.controlModel !== 'stepped_load' || !boundsChargingCurrent(configuration)) {
      return configuration;
    }
    const policy = this.resolve(configuration.id);
    if (policy.kind === 'unrestricted') return configuration;
    if (policy.kind === 'hold') return { ...configuration, carCurrentRangeUnavailable: true };
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
    const installation = this.installations.chargingInstallation(snapshot.id);
    if (installation) {
      this.assertInstallationCurrent(installation, this.installations.installationLevelW(installation.mainId));
      return;
    }
    if (!boundsChargingCurrent(snapshot)) return;
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
    const installation = this.installations.chargingInstallation(request.deviceId);
    if (installation) {
      this.assertInstallationCurrent(installation, request.planningPowerW);
      return;
    }
    const snapshot = this.snapshots.getSnapshotByDeviceId(request.deviceId);
    if (snapshot && !boundsChargingCurrent(snapshot)) return;
    const policy = this.resolve(request.deviceId);
    if (policy.kind === 'unrestricted') return;
    if (policy.kind === 'hold') throw new Error('The charging current limits are unavailable.');
    if (!snapshot) throw new Error('The charger’s current-control configuration is unavailable.');
    this.assertStepWithinRange(request, snapshot, policy.limits);
  }

  private assertStepWithinRange(
    request: SteppedLoadWrite, snapshot: TransportDeviceSnapshot, limits: EvChargingCurrentLimits,
  ): void {
    const config = this.effectiveConfig(request.deviceId, snapshot.targetPowerConfig, limits);
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

/** Charging current ranges bound only a stepped EV charger whose levels carry current. */
function boundsChargingCurrent(snapshot: Pick<TransportDeviceSnapshot,
  'isEvCharger' | 'controlModel' | 'steppedLoadProfile' | 'targetPowerConfig'>): boolean {
  return snapshot.isEvCharger && snapshot.controlModel === 'stepped_load'
    && chargingLadderCarriesCurrent(snapshot.steppedLoadProfile, snapshot.targetPowerConfig?.preset);
}
