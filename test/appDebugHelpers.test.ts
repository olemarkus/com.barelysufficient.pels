import type { Mock } from 'vitest';
import type { DeviceManager } from '../lib/core/deviceManager';
import type { HomeyDeviceLike } from '../lib/utils/types';
import {
  getHomeyDevicesForDebugFromApp,
  logHomeyDeviceComparisonForDebugFromApp,
  logHomeyDeviceForDebug,
  logHomeyDeviceForDebugFromApp,
} from '../lib/app/appDebugHelpers';
import { resetRestClient, setRestClient } from '../lib/core/deviceManagerHomeyApi';

const buildDeviceManager = (params: {
  devices?: HomeyDeviceLike[];
  snapshot?: unknown[];
  observedSources?: unknown;
} = {}): DeviceManager => {
  const {
    devices = [],
    snapshot = [],
    observedSources = null,
  } = params;
  return {
    getDevicesForDebug: vi.fn().mockResolvedValue(devices),
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    getDebugObservedSources: vi.fn().mockReturnValue(observedSources),
  } as unknown as DeviceManager;
};

const findLogPayload = (logger: Mock, message: string): unknown => {
  const call = logger.mock.calls.find(([entry]) => entry === message);
  return call ? call[1] : undefined;
};

const parseDumpPayload = (logger: Mock): Record<string, any> => {
  const dumpPayload = findLogPayload(logger, 'Homey device dump') as { payload?: string } | undefined;
  expect(dumpPayload?.payload).toBeDefined();
  return JSON.parse(dumpPayload?.payload ?? '{}');
};

describe('appDebugHelpers', () => {
  afterEach(() => {
    resetRestClient();
  });

  it('routes debug device fetch failures to app error', async () => {
    const app = {
      deviceManager: {
        getDevicesForDebug: vi.fn().mockRejectedValue({ reason: 'boom' }),
      },
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(getHomeyDevicesForDebugFromApp(app as never)).resolves.toEqual([]);
    expect(app.error).toHaveBeenCalledWith('Failed to get Homey devices for debug', expect.any(Error));
    expect((app.error.mock.calls[0]?.[1] as Error).message).toBe('{"reason":"boom"}');
    expect(app.log).not.toHaveBeenCalled();
  });

  it('logs a single nested device dump when APIs are available', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false, lastUpdated: new Date('2026-03-12T10:00:00.000Z') } },
      settings: { load: 12.5 },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
    });
    const log = vi.fn();
    const error = vi.fn();
    setRestClient({
      get: vi.fn().mockResolvedValue([
        null,
        {
          id: 'dev-1',
          name: 'Kitchen Socket',
          capabilities: ['onoff'],
          capabilitiesObj: {
            onoff: {
              value: true,
              lastUpdated: new Date('2026-03-12T10:02:00.000Z'),
            },
          },
          lastSeenAt: new Date('2026-03-12T10:02:30.000Z'),
        },
      ]),
      put: vi.fn(),
    });

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    const dumpPayload = parseDumpPayload(log);
    expect(dumpPayload.homey.summary).toEqual(expect.objectContaining({
      available: true,
      source: 'listEntry',
      payload: expect.objectContaining({
        id: 'dev-1',
        capabilityValues: {
          onoff: {
            value: false,
            lastUpdated: '2026-03-12T10:00:00.000Z',
          },
        },
      }),
    }));
    expect(dumpPayload.homey.settings).toEqual({
      available: true,
      source: 'listEntry',
      payload: {
        load: 12.5,
      },
    });
    expect(dumpPayload.homey.comparison).toEqual({
      available: true,
      source: 'side_by_side',
      payload: {
        managerDevices: {
          sourceState: 'on',
          lastSeenAt: '2026-03-12T10:02:30.000Z',
          onoffLastUpdated: '2026-03-12T10:02:00.000Z',
        },
        pelsSnapshot: null,
        pelsPlan: null,
      },
    });
  });

  it('logs settings as unavailable when device has no settings', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
    });
    const log = vi.fn();
    const error = vi.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    const dumpPayload = parseDumpPayload(log);
    expect(dumpPayload.homey.summary).toEqual(expect.objectContaining({
      available: true,
      source: 'listEntry',
      payload: expect.objectContaining({
        id: 'dev-1',
        capabilities: ['onoff'],
      }),
    }));
    expect(dumpPayload.homey.settings).toEqual({
      available: false,
      payload: null,
    });
  });

  it('includes settings from device list entry when present', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      settings: { load: 12.5 },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
    });
    const log = vi.fn();
    const error = vi.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).not.toHaveBeenCalled();

    const dumpPayload = parseDumpPayload(log);
    expect(dumpPayload.homey.summary).toEqual(expect.objectContaining({
      available: true,
      source: 'listEntry',
    }));
    expect(dumpPayload.homey.settings).toEqual({
      available: true,
      source: 'listEntry',
      payload: { load: 12.5 },
    });
  });

  it('uses listEntry source when device is found in the device list', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
    });
    const log = vi.fn();
    const error = vi.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).not.toHaveBeenCalled();

    const dumpPayload = parseDumpPayload(log);
    expect(dumpPayload.homey.summary).toEqual(expect.objectContaining({
      available: true,
      source: 'listEntry',
    }));
  });

  it('includes PELS live snapshot and plan state when logging from the app wrapper', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      settings: { load: 12.5 },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
      snapshot: [
        {
          id: 'dev-1',
          name: 'Kitchen Socket',
          targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
          currentOn: false,
          controllable: true,
          managed: true,
        },
      ],
      observedSources: {
        snapshotRefresh: {
          observedAt: Date.parse('2026-03-12T10:05:00.000Z'),
          path: 'snapshot_refresh',
          fetchSource: 'homey_api_getDevices',
          snapshot: {
            id: 'dev-1',
            name: 'Kitchen Socket',
            currentOn: false,
            measuredPowerKw: 0.1,
            targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
          },
        },
        deviceUpdate: {
          observedAt: Date.parse('2026-03-12T10:05:10.000Z'),
          path: 'device_update',
          shouldReconcilePlan: true,
          changes: [{
            capabilityId: 'onoff',
            previousValue: 'on',
            nextValue: 'off',
          }],
          snapshot: {
            id: 'dev-1',
            name: 'Kitchen Socket',
            currentOn: false,
            targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
          },
        },
        realtimeCapabilities: {
          target_temperature: {
            observedAt: Date.parse('2026-03-12T10:05:20.000Z'),
            path: 'realtime_capability',
            capabilityId: 'target_temperature',
            value: 20.5,
            shouldReconcilePlan: true,
            changes: [{
              capabilityId: 'target_temperature',
              previousValue: '18°C',
              nextValue: '20.5°C',
            }],
            snapshot: {
              id: 'dev-1',
              name: 'Kitchen Socket',
              currentOn: false,
              measuredPowerKw: 0.1,
              targets: [{ id: 'target_temperature', value: 20.5, unit: '°C' }],
            },
          },
        },
        localWrites: {
          target_temperature: {
            observedAt: Date.parse('2026-03-12T10:05:30.000Z'),
            path: 'local_write',
            capabilityId: 'target_temperature',
            value: 21,
            preservedLocalState: false,
            snapshot: {
              id: 'dev-1',
              name: 'Kitchen Socket',
              currentOn: false,
              measuredPowerKw: 0.1,
              targets: [{ id: 'target_temperature', value: 20.5, unit: '°C' }],
            },
          },
        },
      },
    });
    const app = {
      deviceManager,
      planService: {
        getLatestPlanSnapshot: vi.fn().mockReturnValue({
          meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
          devices: [
            {
              id: 'dev-1',
              name: 'Kitchen Socket',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 18,
              plannedTarget: 21,
              controllable: true,
            },
          ],
        }),
      },
      error: vi.fn(),
      log: vi.fn(),
    };

    const ok = await logHomeyDeviceForDebugFromApp({
      app: app as never,
      deviceId: 'dev-1',
    });

    expect(ok).toBe(true);
    expect(app.error).not.toHaveBeenCalled();

    const dumpPayload = parseDumpPayload(app.log as Mock);
    expect(dumpPayload.pels).toEqual(expect.objectContaining({
      present: true,
      targetSnapshot: expect.objectContaining({
        id: 'dev-1',
        managed: true,
        controllable: true,
      }),
      planDevice: expect.objectContaining({
        id: 'dev-1',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 21,
      }),
      observedSources: {
        snapshotRefresh: {
          observedAt: '2026-03-12T10:05:00.000Z',
          path: 'snapshot_refresh',
          fetchSource: 'homey_api_getDevices',
          state: {
            sourceState: 'off',
            target: 18,
            powerW: 100,
          },
        },
        deviceUpdate: {
          observedAt: '2026-03-12T10:05:10.000Z',
          path: 'device_update',
          shouldReconcilePlan: true,
          changes: [{
            capabilityId: 'onoff',
            previousValue: 'on',
            nextValue: 'off',
          }],
          state: {
            sourceState: 'off',
            target: 18,
          },
        },
        realtimeCapabilities: {
          target_temperature: {
            observedAt: '2026-03-12T10:05:20.000Z',
            path: 'realtime_capability',
            capabilityId: 'target_temperature',
            value: 20.5,
            shouldReconcilePlan: true,
            changes: [{
              capabilityId: 'target_temperature',
              previousValue: '18°C',
              nextValue: '20.5°C',
            }],
            state: {
              sourceState: 'off',
              target: 20.5,
              powerW: 100,
            },
          },
        },
        localWrites: {
          target_temperature: {
            observedAt: '2026-03-12T10:05:30.000Z',
            path: 'local_write',
            capabilityId: 'target_temperature',
            value: 21,
            preservedLocalState: false,
            state: {
              sourceState: 'off',
              target: 20.5,
              powerW: 100,
            },
          },
        },
      },
    }));
    expect(dumpPayload.homey.comparison).toEqual(expect.objectContaining({
      available: true,
      source: 'side_by_side',
      payload: expect.objectContaining({
        pelsSnapshot: expect.objectContaining({
          sourceState: 'off',
          target: 18,
        }),
        pelsPlan: expect.objectContaining({
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 18,
          plannedTarget: 21,
        }),
      }),
    }));
  });

  it('logs a compact side-by-side comparison from the app wrapper', async () => {
    const app = {
      deviceManager: buildDeviceManager({
        devices: [{
          id: 'dev-1',
          name: 'Kitchen Socket',
          capabilities: ['onoff'],
          capabilitiesObj: { onoff: { value: false } },
        }],
        snapshot: [{
          id: 'dev-1',
          name: 'Kitchen Socket',
          currentOn: false,
          targets: [{ id: 'target_temperature', value: 20.5, unit: '°C' }],
          measuredPowerKw: 0.1,
        }],
      }),
      planService: {
        getLatestPlanSnapshot: () => ({
          meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
          devices: [{
            id: 'dev-1',
            name: 'Kitchen Socket',
            currentState: 'off',
            plannedState: 'keep',
            currentTarget: 20.5,
            plannedTarget: 23,
            controllable: true,
          }],
        }),
      },
      log: vi.fn(),
      error: vi.fn(),
    };
    setRestClient({
      get: vi.fn().mockResolvedValue({
        'dev-1': {
          id: 'dev-1',
          name: 'Kitchen Socket',
          capabilities: ['onoff', 'target_temperature'],
          capabilitiesObj: {
            onoff: { value: true, lastUpdated: new Date('2026-03-12T10:02:00.000Z') },
            target_temperature: { value: 23, lastUpdated: new Date('2026-03-12T10:02:10.000Z') },
          },
          lastSeenAt: new Date('2026-03-12T10:02:30.000Z'),
        },
      }),
      put: vi.fn(),
    });

    const ok = await logHomeyDeviceComparisonForDebugFromApp({
      app: app as never,
      deviceId: 'dev-1',
      reason: 'target_retry:plan:target_temperature',
      expectedTarget: 23,
      observedTarget: 20.5,
      observedSource: 'rebuild',
    });

    expect(ok).toBe(true);
    const comparisonPayload = findLogPayload(app.log as Mock, 'Homey/Pels device state comparison') as { payload?: string } | undefined;
    expect(comparisonPayload?.payload).toBeDefined();
    expect(JSON.parse(comparisonPayload?.payload ?? '{}')).toEqual({
      reason: 'target_retry:plan:target_temperature',
      expectedTarget: 23,
      observedTarget: 20.5,
      observedSource: 'rebuild',
      comparison: {
        managerDevices: {
          sourceState: 'on',
          target: 23,
          lastSeenAt: '2026-03-12T10:02:30.000Z',
          onoffLastUpdated: '2026-03-12T10:02:00.000Z',
          targetLastUpdated: '2026-03-12T10:02:10.000Z',
        },
        pelsSnapshot: {
          sourceState: 'off',
          target: 20.5,
          powerW: 100,
        },
        pelsPlan: {
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 20.5,
          plannedTarget: 23,
        },
      },
    });
  });
});
