import type Homey from 'homey';
import type {
  DeviceActionLogCause,
  DeviceActionLogEntry,
  DeviceActionLogEventKind,
} from '../utils/types';

export type {
  DeviceActionLogCause,
  DeviceActionLogEntry,
  DeviceActionLogEventKind,
} from '../utils/types';

const DEFAULT_RING_BUFFER_SIZE = 100;
const DEFAULT_PERSIST_DEBOUNCE_MS = 2000;

type DeviceActionLogMap = Record<string, DeviceActionLogEntry[]>;

const KNOWN_EVENT_KINDS = new Set<DeviceActionLogEventKind>(['trigger', 'command']);
const KNOWN_CAUSES = new Set<DeviceActionLogCause>([
  'mode',
  'price',
  'shed',
  'restore',
  'expected_power_flow',
  'unknown',
]);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const sanitizeEntry = (value: unknown): DeviceActionLogEntry | null => {
  if (!isRecord(value)) return null;
  const { timestamp, eventKind, cause, message } = value;
  if (!isFiniteNumber(timestamp)) return null;
  if (typeof eventKind !== 'string' || !KNOWN_EVENT_KINDS.has(eventKind as DeviceActionLogEventKind)) return null;
  if (typeof cause !== 'string' || !KNOWN_CAUSES.has(cause as DeviceActionLogCause)) return null;
  if (typeof message !== 'string' || message.trim() === '') return null;
  const normalizedMessage = message.trim();

  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    timestamp,
    eventKind: eventKind as DeviceActionLogEventKind,
    cause: cause as DeviceActionLogCause,
    message: normalizedMessage,
    ...(metadata ? { metadata } : {}),
  };
};

const sanitizeMap = (value: unknown, maxEntriesPerDevice: number): DeviceActionLogMap => {
  if (!isRecord(value)) return {};
  const byDeviceId = new Map<string, DeviceActionLogEntry[]>();
  for (const [rawDeviceId, rawEntries] of Object.entries(value)) {
    const deviceId = rawDeviceId.trim();
    if (!deviceId) continue;
    const entries = Array.isArray(rawEntries)
      ? rawEntries
        .map(sanitizeEntry)
        .filter((entry): entry is DeviceActionLogEntry => entry !== null)
      : [];
    if (entries.length === 0) continue;
    const existingEntries = byDeviceId.get(deviceId) ?? [];
    byDeviceId.set(deviceId, [...existingEntries, ...entries]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-maxEntriesPerDevice));
  }
  return Object.fromEntries(byDeviceId);
};

export class DeviceActionLogStore {
  private data: DeviceActionLogMap = {};
  private persistTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;

  constructor(
    private params: {
      settings: Homey.App['homey']['settings'];
      settingKey: string;
      ringBufferSize?: number;
      persistDebounceMs?: number;
      error: (message: string, error: Error) => void;
    },
  ) {}

  loadFromSettings(): void {
    try {
      this.data = sanitizeMap(
        this.params.settings.get(this.params.settingKey) as unknown,
        this.resolveRingBufferSize(),
      );
      this.dirty = false;
    } catch (error) {
      this.data = {};
      this.dirty = false;
      this.params.error('Failed to load device action log store', error as Error);
    }
  }

  append(deviceId: string, entry: DeviceActionLogEntry): void {
    const trimmedId = deviceId.trim();
    if (!trimmedId) return;
    const entries = this.data[trimmedId] || [];
    entries.push(entry);
    this.data[trimmedId] = entries.slice(-this.resolveRingBufferSize());
    this.markDirty();
  }

  getEntriesNewestFirst(deviceId: string): DeviceActionLogEntry[] {
    const trimmedId = deviceId.trim();
    if (!trimmedId) return [];
    return [...(this.data[trimmedId] || [])].reverse();
  }

  clearDevice(deviceId: string): void {
    const trimmedId = deviceId.trim();
    if (!trimmedId || !this.data[trimmedId]) return;
    delete this.data[trimmedId];
    this.markDirty();
  }

  flushNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persist();
  }

  destroy(): void {
    this.flushNow();
  }

  private resolveRingBufferSize(): number {
    const value = this.params.ringBufferSize;
    return Number.isFinite(value) && (value as number) > 0
      ? Math.floor(value as number)
      : DEFAULT_RING_BUFFER_SIZE;
  }

  private resolvePersistDebounceMs(): number {
    const value = this.params.persistDebounceMs;
    return Number.isFinite(value) && (value as number) >= 0
      ? Math.floor(value as number)
      : DEFAULT_PERSIST_DEBOUNCE_MS;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.resolvePersistDebounceMs() === 0) {
      this.persist();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, this.resolvePersistDebounceMs());
  }

  private persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.params.settings.set(this.params.settingKey, this.data);
    } catch (error) {
      this.dirty = true;
      this.params.error('Failed to persist device action log store', error as Error);
    }
  }
}
