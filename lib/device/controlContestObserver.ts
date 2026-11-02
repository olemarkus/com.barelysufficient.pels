import type { DeviceJournal } from '../ports/deviceJournal';
import type { CapabilityWrite } from './deviceAdapter';
import type { ObservedControlStateChangedEvent } from '../ports/observedStateEvents';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

/**
 * How many rounds of an outside change that PELS then set back, within
 * {@link CONTEST_WINDOW_MS}, make a device contested. A person nudging a
 * thermostat back once or twice an hour is not a contest; a Flow, app or
 * schedule rewriting a setting on a timer is.
 */
export const CONTEST_THRESHOLD = 4;
export const CONTEST_WINDOW_MS = 60 * 60 * 1000;
/** A command stays attributable this long after a newer one replaced it: a slow device's late echo is not a contest. */
const SUPERSEDED_COMMAND_WINDOW_MS = 120_000;
/** The changes the journalled event carries, newest last. */
const CONTEST_EVENT_MAX_CHANGES = 8;

type ControlValue = number | boolean;
/** `before`: the device's value when PELS wrote, when transport had one. */
type Command = { value: ControlValue; before?: ControlValue; supersededAtMs?: number };
/**
 * How a round went: `reverted`, the device went back to its value from before
 * PELS's write (the write did not stick); `overridden`, something set another
 * value (a Flow, app or schedule with its own idea).
 */
export type ContestKind = 'reverted' | 'overridden';
type ContestedChange = {
  atMs: number; capabilityId: string; commanded: ControlValue; observed: ControlValue; kind: ContestKind;
};
type PendingChange = { deviceName: string; change: ContestedChange };

/** A device whose control setting something outside PELS keeps changing back. */
export type ContestedControl = {
  /** The setting changed most recently. */
  capabilityId: string;
  /** `reverted` when every round in the window was one, else `overridden`. */
  kind: ContestKind;
  /** Rounds within the last {@link CONTEST_WINDOW_MS}. */
  count: number;
  /** The first of those rounds. */
  sinceMs: number;
};

const commandKey = (deviceId: string, capabilityId: string): string => `${deviceId}\u0000${capabilityId}`;

const isControlValue = (value: unknown): value is ControlValue => typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));

/** The device's current value for one control setting, from the transport snapshot. */
const snapshotControlValue = (snapshot: TransportDeviceSnapshot, capabilityId: string): ControlValue | undefined => {
  if (capabilityId === snapshot.binaryCapabilityId) {
    const observation = snapshot.binaryControlObservation;
    return observation?.capabilityId === capabilityId ? observation.observedValue : undefined;
  }
  if (capabilityId === 'target_temperature') return snapshot.temperature?.target.value;
  const target = snapshot.targets.find((candidate) => candidate.id === capabilityId);
  return isControlValue(target?.value) ? target.value : undefined;
};

/** Every round in the window a revert means PELS's writes do not stick; any other is an outside actor. */
const contestKind = (changes: readonly ContestedChange[]): ContestKind => (
  changes.every((entry) => entry.kind === 'reverted') ? 'reverted' : 'overridden'
);

/**
 * The value a reported change set, read from the transport snapshot the change
 * was already merged into: a binary axis as on/off, a setpoint as its number.
 * `undefined` for a change this observer cannot compare with a command.
 */
const observedControlValue = (
  snapshot: TransportDeviceSnapshot,
  change: NonNullable<ObservedControlStateChangedEvent['changes']>[number],
): ControlValue | undefined => {
  if (change.capabilityId === snapshot.binaryCapabilityId) {
    if (change.nextValue === 'on') return true;
    if (change.nextValue === 'off') return false;
    return undefined;
  }
  return snapshotControlValue(snapshot, change.capabilityId);
};

/**
 * Observation-side attribution of a control setting that something outside
 * PELS keeps changing away from what PELS commanded: a Flow, another app or a
 * schedule fighting PELS's limits. Knows no plans, modes or policy, only
 * PELS's own writes (`recordCommand`, from the write service) and the control
 * changes transport observed (`observeControlChange`, from the observation
 * bridge, where every one passes).
 *
 * A contest is a back-and-forth: a change away from PELS's command counts once
 * PELS writes that same command again. A change PELS accepts (a temperature it
 * adopts as the mode's target, a command it moves on from) is not one. A round
 * where the device went back to its value from before PELS's write is a write
 * that did not stick (a device app reporting a setting its cloud never took);
 * any other is something else setting the device.
 *
 * When one device has {@link CONTEST_THRESHOLD} such rounds within
 * {@link CONTEST_WINDOW_MS}, it records `device_control_contested` in the
 * device journal and the structured log, at most once per window per device,
 * so the owner's event reports (`lib/diagnostics/eventReportSchedule.ts`) can
 * send a report while the evidence is fresh.
 */
export class ControlContestObserver {
  private readonly commands = new Map<string, Command[]>();
  private readonly pending = new Map<string, PendingChange>();
  private readonly contests = new Map<string, ContestedChange[]>();
  private readonly lastRecordedAtMs = new Map<string, number>();

  constructor(
    private readonly emit: (payload: Record<string, unknown>) => void,
    private readonly journal: DeviceJournal,
  ) {}

  /**
   * PELS asked the device for `write`, with the device as `snapshotBefore`
   * showed it; earlier commands stay attributable for a short while.
   */
  recordCommand(
    deviceId: string,
    write: CapabilityWrite,
    snapshotBefore: TransportDeviceSnapshot | undefined,
    atMs: number,
  ): void {
    const { capabilityId, value } = write;
    if (!isControlValue(value)) return;
    const key = commandKey(deviceId, capabilityId);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (pending && pending.change.commanded === value) this.noteContest(deviceId, pending);
    const recent = (this.commands.get(key) ?? [])
      .map((command) => ({ ...command, supersededAtMs: command.supersededAtMs ?? atMs }))
      .filter((command) => atMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS);
    const before = snapshotBefore ? snapshotControlValue(snapshotBefore, capabilityId) : undefined;
    this.commands.set(key, [...recent, before === undefined ? { value } : { value, before }]);
  }

  observeControlChange(snapshot: TransportDeviceSnapshot | undefined, event: ObservedControlStateChangedEvent): void {
    if (!snapshot || !event.changes) return;
    const atMs = event.observedAtMs ?? Date.now();
    for (const change of event.changes) {
      const commands = this.commands.get(commandKey(event.deviceId, change.capabilityId));
      const standing = commands?.at(-1);
      const observed = observedControlValue(snapshot, change);
      if (!commands || !standing || observed === undefined) continue;
      const key = commandKey(event.deviceId, change.capabilityId);
      const attributable = commands.some((command) => command.value === observed
        && (command.supersededAtMs === undefined || atMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS));
      if (attributable) {
        this.pending.delete(key);
        continue;
      }
      this.pending.set(key, {
        deviceName: snapshot.name,
        change: {
          atMs, capabilityId: change.capabilityId, commanded: standing.value, observed,
          kind: standing.before === observed ? 'reverted' : 'overridden',
        },
      });
    }
  }

  /** The device's contest at `nowMs`, while its rounds within the window reach the threshold. */
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined {
    const changes = (this.contests.get(deviceId) ?? []).filter((entry) => nowMs - entry.atMs < CONTEST_WINDOW_MS);
    const [first] = changes;
    const last = changes.at(-1);
    if (!first || !last || changes.length < CONTEST_THRESHOLD) return undefined;
    return {
      capabilityId: last.capabilityId, kind: contestKind(changes), count: changes.length, sinceMs: first.atMs,
    };
  }

  retainDevices(deviceIds: ReadonlySet<string>): void {
    for (const map of [this.commands, this.pending]) {
      for (const key of map.keys()) {
        if (!deviceIds.has(key.slice(0, key.indexOf('\u0000')))) map.delete(key);
      }
    }
    for (const map of [this.contests, this.lastRecordedAtMs]) {
      for (const id of map.keys()) if (!deviceIds.has(id)) map.delete(id);
    }
  }

  private noteContest(deviceId: string, { deviceName, change }: PendingChange): void {
    const changes = [...(this.contests.get(deviceId) ?? []), change]
      .filter((entry) => change.atMs - entry.atMs < CONTEST_WINDOW_MS);
    this.contests.set(deviceId, changes);
    if (changes.length < CONTEST_THRESHOLD) return;
    const lastAtMs = this.lastRecordedAtMs.get(deviceId);
    if (lastAtMs !== undefined && change.atMs - lastAtMs < CONTEST_WINDOW_MS) return;
    this.lastRecordedAtMs.set(deviceId, change.atMs);
    const event = {
      component: 'devices',
      event: 'device_control_contested',
      deviceId,
      deviceName,
      kind: contestKind(changes),
      windowMs: CONTEST_WINDOW_MS,
      count: changes.length,
      // `changes` ends with `change`, so its head is always present.
      firstAtMs: (changes[0] ?? change).atMs,
      changes: changes.slice(-CONTEST_EVENT_MAX_CHANGES),
    };
    this.emit(event);
    this.journal.record([deviceId], event);
  }
}
