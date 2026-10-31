import type {
  Schedule, ScheduleCommand, ScheduleControls, ScheduleEntry, SchedulesSnapshot,
} from '../../packages/contracts/src/schedules';
import type {
  SettingsUiSmartTaskDevicesResponse, SmartTaskCandidateDevice,
} from '../../packages/contracts/src/smartTaskEdit';
import {
  MAX_SCHEDULES, isScheduleDeletion, isScheduleId, parseSchedule, parseScheduleCommand,
  scheduleConflict, scheduleConflictOnDate, scheduleEligibilityReason,
} from '../../packages/shared-domain/src/settings/schedules';
import type { SettingsPort } from '../ports/homeyRuntime';
import { getLogger } from '../logging/logger';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { ScheduleReceipt, ScheduleReceiptStore } from './scheduleReceipts';
import { dueScheduleOccurrence, nextScheduleOccurrence, scheduleInstant } from './scheduleTime';

export const SCHEDULE_PREFIX = 'schedule.';
export const SCHEDULE_MODES_ENABLED = 'schedule_modes_enabled';
export const SCHEDULE_TASK_ENABLED_PREFIX = 'schedule_task_enabled.';
const logger = getLogger('schedules');

/** One catalog generation for a complete settings projection. */
type ScheduleCatalog = { modes: string[]; taskDevices: SettingsUiSmartTaskDevicesResponse };

/** Complete runtime collaborators; the owner resolves every SDK/config read before execution. */
export type ScheduleRuntimePort = {
  settings: Pick<SettingsPort, 'get' | 'getKeys' | 'set' | 'unset'>;
  clock: { getTimezone(): string };
  timers: TimerRegistry;
  receipts: ScheduleReceiptStore;
  getNowMs(): number;
  listModes(): string[];
  resolveModeName(raw: string): string;
  currentMode(): string;
  listTaskDevices(): SmartTaskCandidateDevice[];
  execute(schedule: Schedule, scheduledAtMs: number): Promise<void>;
};

const groupPaused = (schedule: Schedule, controls: ScheduleControls): boolean => schedule.action.type === 'mode'
  ? !controls.modeChangesEnabled : controls.disabledTaskDeviceIds.includes(schedule.action.task.deviceId);

const controlBoolean = (settings: ScheduleRuntimePort['settings'], keys: readonly string[], key: string): boolean => {
  if (!keys.includes(key)) return true;
  const value = settings.get(key);
  if (typeof value !== 'boolean') throw new Error('Schedule controls are temporarily unavailable. Try again.');
  return value;
};

export class ScheduleService {
  private schedules = new Map<string, Schedule>();
  private controls: ScheduleControls = { modeChangesEnabled: true, disabledTaskDeviceIds: [] };
  private readonly armedAt = new Map<string, number>();
  private lastCheckAt = 0;
  private ticking = false;
  private running = false;
  private loading = false;
  private activeTick: Promise<void> = Promise.resolve();

  constructor(private readonly port: ScheduleRuntimePort) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastCheckAt = this.port.getNowMs();
    try { this.load(); } catch (error) { logger.error({ event: 'schedule_load_failed', err: error }); }
    this.port.timers.registerInterval('scheduleTriggers', setInterval(() => {
      void this.tick().catch((error: unknown) => logger.error({ event: 'schedule_tick_failed', err: error }));
    }, 15_000));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.port.timers.clear('scheduleTriggers');
    try { await this.activeTick; } catch (error) {
      logger.error({ event: 'schedule_stop_drain_failed', err: error });
    }
    this.lastCheckAt = 0;
  }

  onSettingsChanged(key: string): void {
    if (!key.startsWith(SCHEDULE_PREFIX) && key !== SCHEDULE_MODES_ENABLED
      && !key.startsWith(SCHEDULE_TASK_ENABLED_PREFIX)) return;
    try { this.load(); } catch (error) { logger.error({ event: 'schedule_load_failed', err: error }); }
  }

  private load(): void {
    if (this.loading) return;
    this.loading = true;
    try { this.loadConfiguration(); } finally { this.loading = false; }
  }

  private loadConfiguration(): void {
    const keyList = readSettingsKeyList(this.port.settings);
    if (keyList.status === 'unavailable') throw new Error('Schedules are temporarily unavailable. Try again.');
    const { keys } = keyList;
    const next = new Map<string, Schedule>();
    const deleted: string[] = [];
    for (const key of keys.filter((entry) => entry.startsWith(SCHEDULE_PREFIX))) {
      const id = key.slice(SCHEDULE_PREFIX.length);
      if (!isScheduleId(id)) throw new Error('A saved schedule is unavailable. Try again.');
      const raw = this.port.settings.get(key);
      if (isScheduleDeletion(raw)) { deleted.push(id); continue; }
      const schedule = parseSchedule(raw);
      if (schedule.id !== id) throw new Error('A saved schedule is unavailable. Try again.');
      next.set(id, schedule);
    }
    if (next.size > MAX_SCHEDULES) throw new Error(`Use at most ${MAX_SCHEDULES} schedules.`);
    const controls: ScheduleControls = {
      modeChangesEnabled: controlBoolean(this.port.settings, keys, SCHEDULE_MODES_ENABLED),
      disabledTaskDeviceIds: keys.filter((key) => key.startsWith(SCHEDULE_TASK_ENABLED_PREFIX))
        .filter((key) => !controlBoolean(this.port.settings, keys, key))
        .map((key) => key.slice(SCHEDULE_TASK_ENABLED_PREFIX.length)),
    };
    this.acceptConfiguration(next, controls);
    for (const id of deleted) {
      this.port.receipts.delete(id);
      this.port.settings.unset(`${SCHEDULE_PREFIX}${id}`);
    }
    this.schedules = next;
    this.controls = controls;
  }

  private acceptConfiguration(next: Map<string, Schedule>, controls: ScheduleControls): void {
    const now = this.port.getNowMs();
    for (const schedule of next.values()) {
      const changed = JSON.stringify(this.schedules.get(schedule.id)) !== JSON.stringify(schedule);
      const resumed = groupPaused(schedule, this.controls) && !groupPaused(schedule, controls);
      if (changed || resumed) this.armedAt.set(schedule.id, now);
    }
    for (const id of this.schedules.keys()) {
      if (!next.has(id)) { this.armedAt.delete(id); this.port.receipts.delete(id); }
    }
  }

  /** Configuration-only reads for Flow selection and control; no eligibility or receipt projection. */
  definitions(): Schedule[] {
    this.load();
    return [...this.schedules.values()].map((schedule) => structuredClone(schedule));
  }

  lookup(id: string): Schedule {
    this.load();
    return structuredClone(this.requireSchedule(id));
  }

  read(): SchedulesSnapshot {
    this.load();
    const schedules = [...this.schedules.values()];
    const catalog = this.readCatalog(schedules);
    return {
      timeZone: this.port.clock.getTimezone(), modes: [...catalog.modes], controls: structuredClone(this.controls),
      entries: schedules.map((schedule) => this.entry(schedule, catalog)),
    };
  }

  private readCatalog(schedules: readonly Schedule[]): ScheduleCatalog {
    const modes = this.port.listModes();
    if (!schedules.some((schedule) => schedule.enabled && schedule.action.type === 'task')) {
      return { modes, taskDevices: { state: 'ready', devices: [] } };
    }
    try {
      return { modes, taskDevices: { state: 'ready', devices: this.port.listTaskDevices() } };
    } catch (error) {
      logger.error({ event: 'schedule_task_catalog_unavailable', err: error });
      return { modes, taskDevices: { state: 'unavailable' } };
    }
  }

  private entry(schedule: Schedule, catalog: ScheduleCatalog): ScheduleEntry {
    try { return this.projectEntry(schedule, catalog); } catch (error) {
      logger.error({ event: 'schedule_entry_unavailable', scheduleId: schedule.id, err: error });
      return {
        schedule: structuredClone(schedule), modeReferences: [],
        state: 'invalid', nextAtMs: null, nextLabel: '', lastResult: '',
        reason: 'Schedule details are temporarily unavailable. Try again.',
      };
    }
  }

  private projectEntry(schedule: Schedule, catalog: ScheduleCatalog): ScheduleEntry {
    const now = this.port.getNowMs();
    const timeZone = this.port.clock.getTimezone();
    const receipt = this.port.receipts.read(schedule.id);
    const lastResult = receipt?.lastResult ?? '';
    const base = {
      schedule: structuredClone(schedule), modeReferences: this.modeReferences(schedule, catalog.modes),
      nextAtMs: null, nextLabel: '', lastResult,
    };
    if (!schedule.enabled) return { ...base, state: 'off', reason: 'No future triggers' };
    const next = nextScheduleOccurrence(schedule, now, timeZone, receipt?.localOccurrence);
    const invalid = this.catalogEligibility(this.resolveModes(schedule), catalog);
    const conflict = next !== undefined
      && scheduleConflictOnDate(schedule, [...this.schedules.values()], next.key.slice(0, 10));
    if (invalid || conflict) {
      const reason = invalid || 'Another enabled schedule has the same time and target.';
      return { ...base, state: 'invalid', reason };
    }
    if (!next) return { ...base, state: 'finished', reason: 'No future triggers' };
    if (groupPaused(schedule, this.controls)) return {
      ...base, state: 'paused', reason: schedule.action.type === 'mode'
        ? 'Scheduled mode changes are off' : 'Scheduled Smart tasks for this device are off',
    };
    return {
      ...base, state: 'on', reason: '', nextAtMs: next.atMs,
      nextLabel: new Intl.DateTimeFormat('en-GB', {
        timeZone, weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(next.atMs)),
    };
  }

  write(raw: unknown): void {
    const command = parseScheduleCommand(raw);
    this.load();
    if (command.type === 'save') this.save(command.schedule);
    else if (command.type === 'delete') {
      this.requireSchedule(command.id);
      this.port.settings.unset(`${SCHEDULE_PREFIX}${command.id}`);
      this.port.receipts.delete(command.id);
    } else if (command.type === 'set_enabled') {
      const schedule = { ...this.requireSchedule(command.id), enabled: command.enabled };
      if (command.enabled) this.save(schedule);
      else this.port.settings.set(`${SCHEDULE_PREFIX}${command.id}`, schedule);
    } else this.writeGroup(command);
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error('This schedule no longer exists.');
    return schedule;
  }

  private resolveModes(schedule: Schedule): Schedule {
    const condition = schedule.condition.type === 'any' ? schedule.condition : {
      type: schedule.condition.type,
      modes: [...new Set(schedule.condition.modes.map((mode) => this.port.resolveModeName(mode)))],
    };
    const action = schedule.action.type === 'mode'
      ? { type: 'mode' as const, mode: this.port.resolveModeName(schedule.action.mode) } : schedule.action;
    return { ...schedule, condition, action };
  }

  private modeReferences(schedule: Schedule, modes: readonly string[]): ScheduleEntry['modeReferences'] {
    const names = schedule.condition.type === 'any' ? [] : [...schedule.condition.modes];
    if (schedule.action.type === 'mode') names.push(schedule.action.mode);
    return [...new Set(names)].flatMap((stored) => {
      const resolved = this.port.resolveModeName(stored);
      return stored !== resolved && modes.includes(resolved) ? [{ stored, resolved }] : [];
    });
  }

  private catalogEligibility(schedule: Schedule, catalog: ScheduleCatalog): string {
    if (schedule.action.type === 'mode') return scheduleEligibilityReason(schedule, catalog.modes, []);
    return catalog.taskDevices.state === 'ready'
      ? scheduleEligibilityReason(schedule, catalog.modes, catalog.taskDevices.devices)
      : 'Device details are temporarily unavailable. Try again.';
  }

  private eligibility(schedule: Schedule): string {
    const devices = schedule.action.type === 'task' ? this.port.listTaskDevices() : [];
    return scheduleEligibilityReason(this.resolveModes(schedule), this.port.listModes(), devices);
  }

  private save(schedule: Schedule): void {
    const error = this.eligibility(schedule);
    if (error) throw new Error(error);
    if (!this.schedules.has(schedule.id) && this.schedules.size >= MAX_SCHEDULES) {
      throw new Error(`Use at most ${MAX_SCHEDULES} schedules.`);
    }
    const future = [...this.schedules.values()].filter((other) => other.repeat.type !== 'once'
      || nextScheduleOccurrence(other, this.port.getNowMs(), this.port.clock.getTimezone()) !== undefined);
    if (scheduleConflict(schedule, future)) {
      throw new Error('Another enabled schedule has the same time and target. Choose a different time.');
    }
    if (schedule.repeat.type === 'once') {
      const at = scheduleInstant(schedule.repeat.date, schedule.at, this.port.clock.getTimezone());
      if (at === undefined || at <= this.port.getNowMs()) throw new Error('Choose a future date and time.');
    }
    this.port.settings.set(`${SCHEDULE_PREFIX}${schedule.id}`, schedule);
  }

  private writeGroup(command: Exclude<ScheduleCommand, { type: 'save' | 'delete' | 'set_enabled' }>): void {
    if (command.type === 'set_mode_schedules_enabled') {
      this.port.settings.set(SCHEDULE_MODES_ENABLED, command.enabled);
      return;
    }
    const known = [...this.schedules.values()].some((schedule) => (
      schedule.action.type === 'task' && schedule.action.task.deviceId === command.deviceId
    )) || this.port.listTaskDevices().some((device) => device.deviceId === command.deviceId);
    if (!known) throw new Error('This device is not available for scheduled Smart tasks.');
    this.port.settings.set(`${SCHEDULE_TASK_ENABLED_PREFIX}${command.deviceId}`, command.enabled);
  }

  tick(): Promise<void> {
    if (!this.running || this.ticking) return Promise.resolve();
    this.ticking = true;
    this.activeTick = this.runTick().finally(() => { this.ticking = false; });
    return this.activeTick;
  }

  private async runTick(): Promise<void> {
    const now = this.port.getNowMs();
    const after = this.lastCheckAt;
    this.lastCheckAt = Math.max(after, now);
    if (after === 0 || now < after) return;
    this.load();
    for (const schedule of [...this.schedules.values()]) {
      if (!this.running) break;
      try { await this.runDue(schedule, after); } catch (error) {
        logger.error({ event: 'schedule_run_failed', scheduleId: schedule.id, err: error });
      }
    }
  }

  private async runDue(schedule: Schedule, after: number): Promise<void> {
    // A prior action can await a transport while the UI or a Flow changes the configuration.
    if (!this.running) return;
    this.load();
    const current = this.schedules.get(schedule.id);
    if (JSON.stringify(current) !== JSON.stringify(schedule) || !schedule.enabled
      || groupPaused(schedule, this.controls)) return;
    const now = this.port.getNowMs();
    const receipt = this.port.receipts.read(schedule.id);
    const occurrence = dueScheduleOccurrence(
      schedule, Math.max(after, this.armedAt.get(schedule.id) ?? now), now,
      this.port.clock.getTimezone(), receipt?.localOccurrence,
    );
    if (!occurrence) return;
    const lastResult = this.skipReason(schedule, occurrence.key.slice(0, 10));
    const consumed = {
      localOccurrence: occurrence.key, consumedAtMs: now, lastResult: lastResult || 'Trigger recorded.',
    };
    this.port.receipts.write(schedule.id, consumed);
    if (lastResult) return;
    const result = await this.execute(schedule, occurrence.atMs);
    this.finalize(schedule, consumed, result);
  }

  private finalize(schedule: Schedule, consumed: ScheduleReceipt, result: string): void {
    try {
      const keyList = readSettingsKeyList(this.port.settings);
      if (keyList.status === 'unavailable') throw new Error('Schedule settings are unavailable');
      const key = `${SCHEDULE_PREFIX}${schedule.id}`;
      if (!keyList.keys.includes(key)) return;
      const raw = this.port.settings.get(key);
      if (isScheduleDeletion(raw) || JSON.stringify(parseSchedule(raw)) !== JSON.stringify(schedule)) return;
      const receipt = this.port.receipts.read(schedule.id);
      if (!receipt || receipt.localOccurrence !== consumed.localOccurrence
        || receipt.consumedAtMs !== consumed.consumedAtMs) return;
      this.port.receipts.write(schedule.id, { ...consumed, lastResult: result });
    } catch (error) {
      // The pre-action receipt remains durable; failure here can never authorise a replay.
      logger.error({ event: 'schedule_finalize_failed', scheduleId: schedule.id, err: error });
    }
  }

  private skipReason(schedule: Schedule, date: string): string {
    const invalid = this.eligibility(schedule);
    if (invalid) return invalid;
    if (scheduleConflictOnDate(schedule, [...this.schedules.values()], date)) {
      return 'Skipped: another schedule has the same time and target.';
    }
    const condition = this.resolveModes(schedule).condition;
    if (condition.type === 'any') return '';
    const selected = condition.modes.includes(this.port.currentMode());
    const matches = condition.type === 'include' ? selected : !selected;
    return matches ? '' : 'Skipped: the current mode did not match the schedule condition.';
  }

  private async execute(schedule: Schedule, atMs: number): Promise<string> {
    try {
      await this.port.execute(schedule, atMs);
      logger.info({ event: 'schedule_triggered', scheduleId: schedule.id, scheduledAtMs: atMs });
      return schedule.action.type === 'mode' ? 'Mode changed' : 'Smart task created';
    } catch (error) {
      logger.error({ event: 'schedule_action_failed', scheduleId: schedule.id, err: error });
      return error instanceof Error
        ? `Could not run: ${error.message}`.slice(0, 240) : 'Could not run this schedule.';
    }
  }

}
