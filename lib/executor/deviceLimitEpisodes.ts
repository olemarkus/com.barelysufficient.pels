import { isBinaryObservedOn } from '../../packages/shared-domain/src/binaryControlState';
import { hasPlannedStep, type PlannedDeviceCommands } from '../planContract/executionPlan';
import type { PlannedControls } from '../ports/controlContest';
import type { DeviceLimitChange, DeviceLimitEvent } from '../ports/deviceLimitEvents';
import type { ExecutorCommandContext } from './executorCommandContext';
import type { ObserverDeviceRead } from './executorDeviceRead';
import { hasTargetCommand } from './executablePlan';

type ActiveDeviceLimit = {
  atMs: number;
  turnedOff: boolean;
  temperatureC?: number;
  stepId?: string;
};

type DeviceLimitReleaseObservation = {
  turnedOn: boolean;
  temperatureC?: number;
  stepId?: string;
};

/** Tracks limits applied by this executor during its lifetime. */
export class DeviceLimitEpisodes {
  private readonly active = new Map<string, ActiveDeviceLimit>();

  constructor(private readonly emit: (event: DeviceLimitEvent) => void) {}

  record(deviceId: string, deviceName: string, atMs: number, change: DeviceLimitChange): void {
    const episode = this.active.get(deviceId);
    if (change.kind === 'resumed') {
      if (!episode) return;
      this.active.delete(deviceId);
      this.emit({ ...change, deviceId, deviceName, atMs, limitedAtMs: episode.atMs });
      return;
    }

    // An OFF after an earlier OFF proves the device had been turned on in
    // between. Escalating a running limit to OFF remains part of the same hold.
    const continues = episode && !(episode.turnedOff && change.action === 'turned_off');
    const limit = continues ? episode : { atMs, turnedOff: false };
    this.active.set(deviceId, { ...limit, ...appliedSetting(change) });
    if (continues) return;
    const { action, reason, availablePowerKw } = change;
    this.emit({
      kind: 'limited', deviceId, deviceName, atMs, action, reason,
      ...(availablePowerKw === undefined ? {} : { availablePowerKw }),
    });
  }

  forget(deviceId: string): void {
    this.active.delete(deviceId);
  }

  noteRunning(deviceId: string): void {
    const episode = this.active.get(deviceId);
    if (episode?.turnedOff) this.active.set(deviceId, { ...episode, turnedOff: false });
  }

  observeRelease(deviceId: string, read: () => DeviceLimitReleaseObservation): void {
    const episode = this.active.get(deviceId);
    if (!episode) return;
    const observation = read();
    if (episode.turnedOff ? observation.turnedOn : releasedSettings(episode, observation)) this.forget(deviceId);
  }

  retainDevices(planned: Pick<ReadonlyMap<string, unknown>, 'has'>): void {
    for (const deviceId of this.active.keys()) {
      if (!planned.has(deviceId)) this.forget(deviceId);
    }
  }
}

function appliedSetting(change: Extract<DeviceLimitChange, { kind: 'limited' }>): Partial<ActiveDeviceLimit> {
  if (change.action === 'turned_off') return { turnedOff: true };
  if (change.action === 'temperature_setback') return { temperatureC: change.temperatureC };
  return { stepId: change.stepId };
}

function releasedSettings(episode: ActiveDeviceLimit, observation: DeviceLimitReleaseObservation): boolean {
  if (episode.temperatureC === undefined && episode.stepId === undefined) return false;
  const targetReleased = episode.temperatureC === undefined
    || (observation.temperatureC !== undefined && !Object.is(observation.temperatureC, episode.temperatureC));
  const stepReleased = episode.stepId === undefined
    || (observation.stepId !== undefined && observation.stepId !== episode.stepId);
  return targetReleased && stepReleased;
}

/** A release needs an unrestricted decision and a matching accepted observation. */
export function readDeviceLimitRelease(
  ctx: ExecutorCommandContext,
  commands: PlannedDeviceCommands,
  controls: PlannedControls,
  observationsCurrent: boolean,
): DeviceLimitReleaseObservation {
  const { id } = commands;
  const binaryPending = Boolean(ctx.pendingBinaryCommandStore.peekActive(id));
  const observed = ctx.getObservedState(id);
  const turnedOn = !binaryPending && isBinaryObservedOn(observed);
  if (!observationsCurrent || commands.deviceLimit || !commands.commandAuthority
    || !observed?.available || binaryPending) return { turnedOn };
  return {
    turnedOn,
    temperatureC: readReleasedTemperature(ctx, commands, controls, observed),
    stepId: readReleasedStep(ctx, commands, controls, observed),
  };
}

function readReleasedTemperature(
  ctx: ExecutorCommandContext,
  commands: PlannedDeviceCommands,
  controls: PlannedControls,
  observed: ObserverDeviceRead,
): number | undefined {
  if (!hasTargetCommand(commands) || commands.target.purpose !== 'target_update'
    || ctx.targetCommands.pendingTargetCommands[commands.id]) return undefined;
  const temperatureC = observed.targets?.[0]?.value;
  return Object.is(temperatureC, controls.temperature) ? temperatureC : undefined;
}

function readReleasedStep(
  ctx: ExecutorCommandContext,
  commands: PlannedDeviceCommands,
  controls: PlannedControls,
  observed: ObserverDeviceRead,
): string | undefined {
  if (!hasPlannedStep(commands) || commands.steppedLoad.stepDirection !== 'any'
    || commands.steppedLoad.plannedShedTarget
    || ctx.getSteppedLoadCommandSession(commands.id).stepCommandPending) return undefined;
  return observed.reportedStepId === controls.level ? observed.reportedStepId : undefined;
}
