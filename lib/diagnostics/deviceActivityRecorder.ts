import { randomUUID } from 'node:crypto';
import type {
  SettingsUiDeviceActivityEntry,
  SettingsUiDeviceLogEntry,
  SettingsUiDeviceLogPayload,
} from '../../packages/contracts/src/settingsUi/devices';
import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUi/plan';
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

/**
 * A row the device leaves within this long says nothing an owner needs: a
 * device commanded off reads `Limited` until it reports off a second later, and
 * `Resuming` turns `Running` as soon as it draws. The newer row takes its place
 * and keeps the time the change began (owner, 2026-10-27).
 */
export const DEVICE_ACTIVITY_SETTLE_MS = 10_000;

/**
 * A device's newest row while it may still be replaced, with the log's own
 * signature of the state it records (`DeviceOverviewTransitions`), which says
 * whether a later row only returns to it.
 */
type SettlingRow = { entry: SettingsUiDeviceActivityEntry; signature: string };

/** History failure cannot interrupt a decision or a device command. */
export class DeviceOverviewLogRecorder {
  private readonly recordingStartedAtMs = Date.now();
  private readonly sessionId = randomUUID();
  private sequence = 0;
  private readonly settling = new Map<string, SettlingRow>();
  /** The signature of the row each device settled on last, which a settling row may return to. */
  private readonly settledSignatureById = new Map<string, string>();
  private pending: SettingsUiDeviceActivityEntry[] = [];
  private retryAfterMs = 0;

  constructor(private readonly store: DeviceActivityStore) {}

  /** `signature` is the log's signature of the state `entry` records. */
  record(device: SettingsUiPlanDeviceSnapshot, entry: SettingsUiDeviceLogEntry, signature: string): void {
    const previous = this.settling.get(device.id);
    // Measured from when the row began, so a device changing every few seconds still settles.
    if (previous && entry.atMs - previous.entry.atMs < DEVICE_ACTIVITY_SETTLE_MS) {
      // Back where it was within moments: nothing happened worth a row.
      if (signature === this.settledSignatureById.get(device.id)) {
        this.settling.delete(device.id);
        return;
      }
      const { id, atMs } = previous.entry;
      const replaced = { ...previous.entry, ...entry, id, atMs, deviceName: device.name };
      this.settling.set(device.id, { entry: replaced, signature });
      return;
    }
    if (previous) this.settle(previous);
    this.settling.set(device.id, { signature, entry: {
      ...entry, id: `${this.sessionId}:${String(this.sequence).padStart(10, '0')}`,
      deviceId: device.id, deviceName: device.name,
      recordingStartedAtMs: this.recordingStartedAtMs,
    } });
    this.sequence += 1;
  }

  /** Called after each overview capture, including captures with no new transition. */
  flush(): void {
    const nowMs = Date.now();
    for (const [deviceId, row] of this.settling) {
      if (nowMs - row.entry.atMs < DEVICE_ACTIVITY_SETTLE_MS) continue;
      this.settling.delete(deviceId);
      this.settle(row);
    }
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
    const settling = [...this.settling.values()].map((row) => row.entry);
    return {
      version: 2,
      entries: retainDeviceActivity([...settling, ...this.pending, ...stored], nowMs),
      retentionDays: DEVICE_ACTIVITY_RETENTION_DAYS,
      maxEntriesPerDevice: DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE,
      maxEntries: DEVICE_ACTIVITY_MAX_ENTRIES,
      persistence: this.pending.length || this.settling.size ? 'pending' : 'stored',
    };
  }

  private settle({ entry, signature }: SettlingRow): void {
    this.settledSignatureById.set(entry.deviceId, signature);
    this.pending = retainDeviceActivity([entry, ...this.pending], Date.now());
  }
}
