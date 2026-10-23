import { randomUUID } from 'node:crypto';
import type {
  SettingsUiDeviceActivityEntry,
  SettingsUiDeviceLogEntry,
  SettingsUiDeviceLogPayload,
  SettingsUiPlanDeviceSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import {
  DEVICE_ACTIVITY_MAX_ENTRIES,
  DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE,
  DEVICE_ACTIVITY_RETENTION_DAYS,
  retainDeviceActivity,
  type DeviceActivityStore,
} from './deviceActivityHistory';

const logger = getLogger('diagnostics/device-activity');
const RETRY_MS = 30_000;

/** History failure cannot interrupt a decision or a device command. */
export class DeviceOverviewLogRecorder {
  private readonly recordingStartedAtMs = Date.now();
  private readonly sessionId = randomUUID();
  private sequence = 0;
  private pending: SettingsUiDeviceActivityEntry[] = [];
  private retryAfterMs = 0;

  constructor(private readonly store: DeviceActivityStore) {}

  record(device: SettingsUiPlanDeviceSnapshot, entry: SettingsUiDeviceLogEntry): void {
    this.pending = retainDeviceActivity([{
      ...entry, id: `${this.sessionId}:${String(this.sequence).padStart(10, '0')}`,
      deviceId: device.id, deviceName: device.name,
      recordingStartedAtMs: this.recordingStartedAtMs,
    }, ...this.pending], Date.now());
    this.sequence += 1;
  }

  /** Called after each overview capture, including captures with no new transition. */
  flush(): void {
    const nowMs = Date.now();
    this.pending = retainDeviceActivity(this.pending, nowMs);
    if (this.pending.length === 0 || nowMs < this.retryAfterMs) return;
    try {
      this.store.append(this.pending, nowMs);
      this.pending = [];
      this.retryAfterMs = 0;
    } catch (error) {
      if (this.retryAfterMs === 0) logger.error({ event: 'device_activity_write_failed', err: normalizeError(error) });
      this.retryAfterMs = nowMs + RETRY_MS;
    }
  }

  getUiPayload(): SettingsUiDeviceLogPayload {
    this.flush();
    const nowMs = Date.now();
    // A failed read surfaces as unavailable, never a reassuring empty history.
    const stored = this.store.read(nowMs);
    return {
      version: 2,
      entries: retainDeviceActivity([...this.pending, ...stored], nowMs),
      retentionDays: DEVICE_ACTIVITY_RETENTION_DAYS,
      maxEntriesPerDevice: DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE,
      maxEntries: DEVICE_ACTIVITY_MAX_ENTRIES,
      persistence: this.pending.length ? 'pending' : 'stored',
    };
  }
}
