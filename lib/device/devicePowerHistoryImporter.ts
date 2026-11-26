import {
  DEVICE_POWER_HISTORY_IMPORT, readDevicePowerHistoryImport,
  type DevicePowerHistoryImportOutcome, type DevicePowerHistoryImportRequest,
} from '../../packages/shared-domain/src/settings/devicePowerHistoryImport';
import { DEVICE_POWER_SOURCES } from '../../packages/shared-domain/src/settings/settingsKeys';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { findMeterPowerLog, learnFromMeterHistory } from './devicePowerHistory';
import type { FlowBackedDeviceState } from './flowBackedDeviceState';

type PowerHistorySettings = Pick<SettingsPort, 'get' | 'set'> & {
  on(event: 'set' | 'unset', listener: (key: string) => void): unknown;
  off(event: 'set' | 'unset', listener: (key: string) => void): unknown;
};

const REQUEST_TIMEOUT_MS = 15_000;
const logger = getLogger('device/power-history-import');

/** Handles only explicit live requests. A request left in settings on restart is never replayed. */
export class DevicePowerHistoryImporter {
  private active = false;
  private running: DevicePowerHistoryImportRequest | undefined;
  private sourceChanged = false;

  constructor(
    private readonly settings: PowerHistorySettings,
    private readonly devices: Pick<FlowBackedDeviceState, 'readPowerHistorySource' | 'saveLearnedPowerFromHistory'>,
    private readonly getInsights: (path: string) => Promise<unknown>,
    private readonly refreshDeviceSnapshot: () => Promise<void>,
  ) {}

  attach(): () => void {
    this.active = true;
    this.settings.on('set', this.changed);
    this.settings.on('unset', this.changed);
    return () => {
      this.active = false;
      this.settings.off('set', this.changed);
      this.settings.off('unset', this.changed);
    };
  }

  private readonly changed = (key: string): void => {
    // Homey reports the key, not the value. A delayed notification can
    // arrive after the source has already changed back to its previous ID.
    if (key === DEVICE_POWER_SOURCES && this.running) this.sourceChanged = true;
    if (key === DEVICE_POWER_HISTORY_IMPORT) this.startNext();
  };

  private readRequest(): DevicePowerHistoryImportRequest | undefined {
    const message = readDevicePowerHistoryImport(this.settings.get(DEVICE_POWER_HISTORY_IMPORT));
    return message?.kind === 'request' ? message : undefined;
  }

  private isCurrent(request: DevicePowerHistoryImportRequest): boolean {
    return this.active && this.readRequest()?.id === request.id;
  }

  private matchesCurrentSource(request: DevicePowerHistoryImportRequest): boolean {
    return this.devices.readPowerHistorySource(request.deviceId) === request.sourceDeviceId;
  }

  private startNext(previousId?: string): void {
    if (!this.active || this.running) return;
    try {
      const request = this.readRequest();
      if (!request || request.id === previousId) return;
      this.running = request;
      this.sourceChanged = false;
      void this.process(request).finally(() => {
        this.running = undefined;
        if (this.active) this.startNext(request.id);
      });
    } catch {
      logger.warn({ event: 'device_power_history_import_settings_unavailable' });
    }
  }

  private async process(request: DevicePowerHistoryImportRequest): Promise<void> {
    try {
      const outcome = await this.importHistory(request);
      if (outcome === 'imported') this.refreshImportedEstimate();
      if (this.isCurrent(request)) {
        this.settings.set(DEVICE_POWER_HISTORY_IMPORT, { kind: 'result', id: request.id, outcome });
        logger.info({ event: 'device_power_history_import_completed', deviceId: request.deviceId, outcome });
      }
    } catch (error) {
      logger.warn({ event: 'device_power_history_import_failed', err: normalizeError(error) });
    }
  }

  private refreshImportedEstimate(): void {
    void this.refreshDeviceSnapshot().catch((error: unknown) => {
      logger.warn({ event: 'device_power_history_refresh_failed', err: normalizeError(error) });
    });
  }

  private async importHistory(request: DevicePowerHistoryImportRequest): Promise<DevicePowerHistoryImportOutcome> {
    if (!this.matchesCurrentSource(request)) return 'source_changed';
    const requestedAtMs = Date.now();
    const { sourceDeviceId } = request;
    const peak = await this.readPeakBeforeDeadline(sourceDeviceId, requestedAtMs);
    if (this.sourceChanged || !this.isCurrent(request) || !this.matchesCurrentSource(request)) {
      return 'source_changed';
    }
    if (!peak) return 'history_unavailable';
    return this.devices.saveLearnedPowerFromHistory(request.deviceId, peak);
  }

  private async readPeakBeforeDeadline(sourceDeviceId: string, requestedAtMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.readPeak(sourceDeviceId, requestedAtMs), deadline]);
    } catch (error) {
      logger.warn({ event: 'device_power_history_read_failed', err: normalizeError(error) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readPeak(sourceDeviceId: string, requestedAtMs: number) {
    const log = findMeterPowerLog(await this.getInsights('manager/insights/log'), sourceDeviceId);
    if (!log) return undefined;
    const entries = await this.getInsights(
      `manager/insights/log/${log.ownerUri}/${log.id}/entry?resolution=lastHour`,
    );
    return learnFromMeterHistory(entries, log, requestedAtMs, sourceDeviceId);
  }
}
