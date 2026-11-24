import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';
import type { BinaryPlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import { getSteppedLoadHighestStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type { PlannedBinaryCommand } from '../planContract/executionPlan';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { toInstallationSwitch } from './chargingInstallationSwitchDecision';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice } from './planTypes';
import { resolveHeldChargeTarget } from './shedding/chargeTargetHold';

const installationOf = (device: PlanInputDevice | DevicePlanDevice) => device.controlAdapter?.chargingInstallation;

const memberHeld = (device: PlanInputDevice): boolean => (
  device.externalOffHoldActive === true || resolveHeldChargeTarget(device) !== null
  || device.deferredHold !== undefined || device.carCurrentRangeUnavailable === true
);

function withoutDraw(device: PlanInputDevice): PlanInputDevice {
  if (!isMeteredPlanDevice(device)) return device;
  const { currentDrawKw: _draw, ...remaining } = device;
  return remaining;
}

function installationFootprint(
  device: PlanInputDevice, members: readonly PlanInputDevice[],
): PlanInputDevice['phaseFootprint'] {
  const main = device.phaseFootprint;
  const matchesMain = members.every(({ phaseFootprint }) => phaseFootprint.kind === main.kind
    && (main.kind !== 'single' || (phaseFootprint.kind === 'single' && phaseFootprint.phase === main.phase)));
  return matchesMain ? main : { kind: 'unknown' };
}

function planInstallationLoad(device: PlanInputDevice, members: readonly PlanInputDevice[]): PlanInputDevice {
  const load = device.chargingInstallationLoad;
  if (!load) return withoutDraw(device);
  const { externalOffHoldActive: _ownerHold, deferredHold: _taskHold, waitingForTaskPlan: _taskPending,
    carCurrentRangeUnavailable: _carRange, ...base } = withoutDraw(device);
  const level = load.level;
  const canStep = device.available && (level !== undefined || !load.running);
  const currentOn = load.running && level?.watts !== 0;
  const reachable = members.filter((member) => member.commandableNow && !memberHeld(member));
  const eligible = reachable.filter((member) => !member.waitingForTaskPlan);
  const capacityDevice = {
    ...base,
    // A command range may exclude the current rung. Keep the separately
    // observed level so a required correction is still recognized as a descent.
    ...(level ? { selectedStepId: level.stepId, planningPowerKw: level.watts / 1000 } : {}),
    reportedStepId: level?.stepId,
    currentOn,
    currentState: currentOn ? 'on' as const : 'off' as const,
    available: members.some((member) => member.available),
    phaseFootprint: installationFootprint(device, members),
    commandableNow: reachable.length > 0,
    ...installationClaims(eligible, canStep && isSteppedLoadDevice(device)),
    chargeTargetHold: { kind: 'none' as const },
    confirmedNotDrawing: false,
    ...(load.currentDrawKw !== undefined ? { currentDrawKw: load.currentDrawKw } : {}),
  };
  return canStep ? capacityDevice : planSwitchOnlyInstallation(capacityDevice, members);
}

function planSwitchOnlyInstallation(device: PlanInputDevice, members: readonly PlanInputDevice[]): PlanInputDevice {
  const withoutInstallationDraw = withoutDraw(device);
  if (!isSteppedLoadDevice(withoutInstallationDraw)) return device;
  const {
    steppedLoadProfile, selectedStepId: _selected, planningPowerKw: _planning, reportedStepId: _reported,
    desiredStepId: _desired, previousStepId: _previous, targetPowerClaimNeeded: _claim,
    lastStepCommandIssuedAt: _issued, nextStepCommandRetryAtMs: _nextRetry, stepCommandPending: _pending,
    stepCommandStatus: _status, stepCommandRetryCount: _retries, ...base
  } = withoutInstallationDraw;
  const available = members.filter((member) => member.available);
  const draw = available.filter(isMeteredPlanDevice).map(({ currentDrawKw }) => currentDrawKw);
  const currentDrawKw = draw.reduce((total, kw) => total + kw, 0);
  const retainedW = device.chargingInstallationLoad?.level?.watts;
  const currentOn = retainedW !== 0 && available.some((member) => isBinaryPlanDevice(member) && member.currentOn);
  const maximumW = getSteppedLoadHighestStep(steppedLoadProfile)?.planningPowerW ?? device.expectedPowerKw * 1000;
  const restoreKw = (retainedW ?? maximumW) / 1000;
  const switchOnly = {
    ...base,
    ...(draw.length > 0 ? { currentDrawKw } : {}),
    controlModel: 'binary_power',
    currentOn,
    currentState: currentOn ? 'on' : 'off',
    commandableNow: device.commandableNow && (currentOn || (retainedW ?? 0) > 0),
    expectedPowerKw: restoreKw,
    residualKw: { shed: currentDrawKw, restore: { kw: restoreKw, source: 'planning' } },
  } satisfies PlanInputDevice & BinaryPlanInputKind;
  return switchOnly;
}

function installationClaims(members: readonly PlanInputDevice[], stepped: boolean) {
  return {
    boostSupported: stepped && members.length > 0,
    boostRequested: members.some((member) => member.boostRequested),
    forceBoostActive: members.some((member) => member.forceBoostActive === true),
    // Admission protects the shared current. Exempt energy is still attributed
    // from the members' separate power readings (usageDevices below).
    budgetExempt: members.some((member) => member.budgetExempt),
    reservesStartupPower: members.some((member) => member.reservesStartupPower === true),
  };
}

export class ChargingInstallationPlan {
  private readonly members: ReadonlyMap<string, PlanInputDevice>;

  constructor(private readonly decoration: DeferredDecorationBundle) {
    this.members = new Map(decoration.admittedDevices.filter(installationOf).map((device) => [device.id, device]));
  }

  /** Usage uses each charger's own draw and exemption. Capacity uses the shared lever below. */
  get usageDevices(): PlanInputDevice[] {
    return this.decoration.admittedDevices;
  }

  forCapacity(): DeferredDecorationBundle {
    if (this.members.size === 0) return this.decoration;
    const { admittedDevices, forceShedSet, deferredReleaseIntentByDeviceId } = this.decoration;
    return {
      ...this.decoration,
      admittedDevices: admittedDevices.map((device) => {
        const installation = installationOf(device);
        if (!installation) return device;
        if (installation.role === 'secondary') return withoutDraw(device);
        const members = installation.memberIds.flatMap((id) => {
          const member = this.members.get(id);
          return member ? [member] : [];
        });
        return planInstallationLoad(device, members);
      }),
      // A member's task may only pause that member's switch.
      forceShedSet: new Set([...forceShedSet].filter((id) => !this.members.has(id))),
      deferredReleaseIntentByDeviceId: Object.fromEntries(
        Object.entries(deferredReleaseIntentByDeviceId).filter(([id]) => !this.members.has(id)),
      ),
    };
  }

  withSwitches(plan: DevicePlan): DevicePlan {
    if (this.members.size === 0) return plan;
    const switches = new Map(plan.devices.flatMap((device) => {
      const member = this.members.get(device.id);
      if (!member?.chargingInstallationLoad) return [];
      const switchDecision = toInstallationSwitch(device, member, plan.meta.powerIsMeasured);
      return [[device.id, switchDecision] as const];
    }));
    return {
      ...plan,
      devices: plan.devices.map((device) => {
        const installation = installationOf(device);
        const member = this.members.get(device.id);
        if (!installation || !member || !isBinaryPlanDevice(member) || !member.control.commandAuthority) return device;
        const groupSwitch = switches.get(installation.mainId) ?? null;
        const command = this.planMemberSwitch(member, groupSwitch, device);
        if (!command) return device;
        const orderedPause = !plan.meta.powerIsMeasured && groupSwitch === false;
        const chargingInstallationSwitch = orderedPause
          ? { ...command, meterSilencePausePrimaryId: installation.mainId } : command;
        return { ...device, chargingInstallationSwitch };
      }),
    };
  }

  private planMemberSwitch(
    member: PlanInputDevice, groupSwitch: boolean | null, device: DevicePlanDevice,
  ): PlannedBinaryCommand | undefined {
    const ownHold = memberHeld(member) || this.decoration.forceShedSet.has(member.id)
      || this.decoration.deferredReleaseIntentByDeviceId[member.id]?.kind === 'binary_release';
    const mayStart = !member.waitingForTaskPlan && member.commandableNow
      && device.plannedState === 'keep' && !isRestoreAdmissionHoldReason(device.reason);
    if (!ownHold && (groupSwitch === null || (groupSwitch && !mayStart))) return undefined;
    return {
      deviceId: member.id, name: member.name, desiredOn: !ownHold && groupSwitch === true,
      source: 'controlled', binarySwitchGeneration: member.binarySwitchGeneration,
      ...(ownHold ? {} : { chargingInstallationId: installationOf(device)?.id }),
    };
  }
}
