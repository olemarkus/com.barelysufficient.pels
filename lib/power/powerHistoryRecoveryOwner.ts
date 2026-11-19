import type { PowerHistoryRecoveryRead } from '../../packages/contracts/src/powerHistoryRecovery';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import {
  POWER_HISTORY_RECOVERY_REQUEST, readPowerHistoryRecoveryRequest,
} from '../../packages/shared-domain/src/settings/powerHistoryRecovery';
import type { ConfiguredPowerSourceRead } from '../ports/configuredPowerSource';
import type { HomeTrackerPersistence } from './homeTrackerPersistence';
import { readHourlyInsightsLogs, resolveHourlyInsightsHistory } from './insightsHourlyHistory';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

type SettingsEvents = {
  on(event: 'set' | 'unset', listener: (key: string) => void): unknown;
  removeListener(event: 'set' | 'unset', listener: (key: string) => void): unknown;
};

export type PowerHistoryRecoveryPorts = {
  readRequest(): unknown;
  clearRequest(): void;
  readPowerSource(): ConfiguredPowerSourceRead;
  readMainMeterSelection(): MainMeterSelection;
  fetchInsights(path: string): Promise<unknown>;
  getTracker(): HomeTrackerPersistence;
  nowMs(): number;
  readTimeZone(): string;
  isTornDown(): boolean;
  onUpdated(): void;
};

/** Explicit, additive recovery; persisted commands are never replayed on boot. */
export class PowerHistoryRecoveryOwner {
  private outcome: PowerHistoryRecoveryRead = { state: 'idle' };
  private active = false;
  private running = false;
  private generation = 0;
  private readonly processed = new Set<string>();

  constructor(private readonly ports: PowerHistoryRecoveryPorts) {}

  read(): PowerHistoryRecoveryRead { return this.outcome; }

  attach(settings: SettingsEvents): void {
    try { this.ports.clearRequest(); } catch (error) {
      this.logFailure(error);
      return;
    }
    this.active = true;
    settings.on('set', this.onSettingChanged);
  }

  detach(settings: SettingsEvents): void {
    this.active = false;
    this.generation += 1;
    settings.removeListener('set', this.onSettingChanged);
  }

  onSettingChanged = (key: string): void => {
    if (key !== POWER_HISTORY_RECOVERY_REQUEST || !this.active || this.ports.isTornDown()) return;
    let request;
    try {
      request = readPowerHistoryRecoveryRequest(this.ports.readRequest());
      this.ports.clearRequest();
    } catch (error) {
      this.logFailure(error);
      return;
    }
    if (!request || this.processed.has(request.id)) return;
    this.processed.add(request.id);
    if (this.processed.size > 32) this.processed.delete(this.processed.values().next().value as string);
    if (this.running) {
      this.outcome = { state: 'failed', requestId: request.id, message: 'Hourly history recovery is already running.' };
      return;
    }
    this.running = true;
    this.outcome = { state: 'running', requestId: request.id };
    void this.recover(request.id).finally(() => { this.running = false; });
  };

  private selectedMeter(): string {
    const source = this.ports.readPowerSource();
    const meter = this.ports.readMainMeterSelection();
    if (source.state !== 'resolved' || source.value !== 'homey_energy' || meter.state !== 'resolved') {
      throw new Error('Select a whole-home meter using Homey Energy before recovering hourly history.');
    }
    return meter.meterDeviceId;
  }

  private async fetchWithDeadline(path: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Insights history took too long to respond. Try recovery again.'));
      }, 20_000);
    });
    try {
      return await Promise.race([this.ports.fetchInsights(path), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recover(requestId: string): Promise<void> {
    const generation = this.generation;
    try {
      const meter = this.selectedMeter();
      const timeZone = this.ports.readTimeZone();
      const tracker = this.ports.getTracker();
      const revision = tracker.getHistoryRevision();
      const logs = readHourlyInsightsLogs(await this.fetchWithDeadline('manager/insights/log'), meter);
      const entryPath = (log: { ownerUri: string; id: string }): string => (
        `manager/insights/log/${log.ownerUri}/${log.id}/entry?resolution=last7Days`
      );
      const [power, exported] = await Promise.all([
        this.fetchWithDeadline(entryPath(logs.power)), this.fetchWithDeadline(entryPath(logs.exported)),
      ]);
      if (!this.active || this.ports.isTornDown() || this.generation !== generation
        || this.selectedMeter() !== meter || this.ports.readTimeZone() !== timeZone
        || this.ports.getTracker() !== tracker || tracker.getHistoryRevision() !== revision) {
        throw new Error('The meter or usage history changed. Start hourly history recovery again.');
      }
      const nowMs = this.ports.nowMs();
      const hours = resolveHourlyInsightsHistory(power, exported, logs, tracker.getHistoryForRecovery(), nowMs);
      const result = tracker.appendMissingHours(hours, revision, nowMs);
      if (result.state !== 'saved') throw new Error(result.state === 'stale'
        ? 'The usage history changed. Start hourly history recovery again.'
        : 'Recovered hourly history could not be saved.');
      this.outcome = { state: 'done', requestId, addedHours: result.addedHours,
        ...(result.firstHour === undefined ? {} : { firstHour: result.firstHour, lastHour: result.lastHour }) };
      // Durable success is independent of a downstream UI/model refresh.
      try { this.ports.onUpdated(); } catch (error) { this.logFailure(error); }
    } catch (error) {
      this.outcome = { state: 'failed', requestId,
        message: error instanceof Error ? error.message : 'Hourly history recovery failed.' };
      this.logFailure(error);
    }
  }

  private logFailure(error: unknown): void {
    getLogger('power/history-recovery').error({ event: 'power_history_recovery_failed', err: normalizeError(error) });
  }
}
