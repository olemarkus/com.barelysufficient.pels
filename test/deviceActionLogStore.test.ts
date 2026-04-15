import { DeviceActionLogStore } from '../lib/app/deviceActionLogStore';

describe('DeviceActionLogStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sanitizes persisted entries and returns newest entries first', () => {
    const persisted = new Map<string, unknown>([
      ['device_action_log_by_device', {
        heater: [
          { timestamp: 1, eventKind: 'trigger', cause: 'mode', message: '  Mode changed to Away  ' },
          { timestamp: 2, eventKind: 'bad', cause: 'mode', message: 'bad event' },
          { timestamp: 3, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
        ],
      }],
    ]);
    const store = new DeviceActionLogStore({
      settings: {
        get: (key: string) => persisted.get(key),
        set: vi.fn(),
      } as never,
      settingKey: 'device_action_log_by_device',
      error: vi.fn(),
    });

    store.loadFromSettings();

    expect(store.getEntriesNewestFirst('heater')).toEqual([
      { timestamp: 3, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
      { timestamp: 1, eventKind: 'trigger', cause: 'mode', message: 'Mode changed to Away' },
    ]);
  });

  it('merges persisted buckets that differ only by surrounding whitespace', () => {
    const persisted = new Map<string, unknown>([
      ['device_action_log_by_device', {
        ' heater ': [
          { timestamp: 1, eventKind: 'trigger', cause: 'mode', message: 'Mode changed to Away' },
        ],
        heater: [
          { timestamp: 2, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
        ],
      }],
    ]);
    const store = new DeviceActionLogStore({
      settings: {
        get: (key: string) => persisted.get(key),
        set: vi.fn(),
      } as never,
      settingKey: 'device_action_log_by_device',
      error: vi.fn(),
    });

    store.loadFromSettings();

    expect(store.getEntriesNewestFirst('heater')).toEqual([
      { timestamp: 2, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
      { timestamp: 1, eventKind: 'trigger', cause: 'mode', message: 'Mode changed to Away' },
    ]);
  });

  it('persists appended entries with ring-buffer trimming', () => {
    const set = vi.fn();
    const store = new DeviceActionLogStore({
      settings: {
        get: vi.fn().mockReturnValue(undefined),
        set,
      } as never,
      settingKey: 'device_action_log_by_device',
      ringBufferSize: 2,
      persistDebounceMs: 50,
      error: vi.fn(),
    });

    store.loadFromSettings();
    store.append('heater', { timestamp: 1, eventKind: 'trigger', cause: 'mode', message: 'Mode changed' });
    store.append('heater', { timestamp: 2, eventKind: 'command', cause: 'price', message: 'Raised target' });
    store.append('heater', { timestamp: 3, eventKind: 'command', cause: 'shed', message: 'Turned off heater' });

    vi.advanceTimersByTime(50);

    expect(set).toHaveBeenCalledWith('device_action_log_by_device', {
      heater: [
        { timestamp: 2, eventKind: 'command', cause: 'price', message: 'Raised target' },
        { timestamp: 3, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
      ],
    });
    expect(store.getEntriesNewestFirst('heater')).toEqual([
      { timestamp: 3, eventKind: 'command', cause: 'shed', message: 'Turned off heater' },
      { timestamp: 2, eventKind: 'command', cause: 'price', message: 'Raised target' },
    ]);
  });
});
