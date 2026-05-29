import { runFlowConflictProbe } from '../setup/flowConflictProbe';
import { FLOW_API_PATH, ADVANCED_FLOW_API_PATH, type FlowApiGet } from '../lib/flowApi/readUserFlows';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { Logger as PinoLogger } from 'pino';

const hoiaxId = 'hoiax-1';

const steppedDevice = (id: string, nativeWriteCapabilities: string[]): TargetDeviceSnapshot => ({
  id,
  name: id,
  nativeWriteCapabilities,
} as unknown as TargetDeviceSnapshot);

const captureLog = () => {
  const events: Array<Record<string, unknown>> = [];
  const logger = { info: (e: Record<string, unknown>) => { events.push(e); } } as unknown as PinoLogger;
  return { logger, events };
};

const getReturning = (responses: Record<string, unknown>): FlowApiGet => async (path) => {
  if (path in responses) return responses[path];
  throw new Error(`unexpected path ${path}`);
};

describe('runFlowConflictProbe', () => {
  it('logs a conflict when a Flow writes a capability a candidate device owns', async () => {
    const { logger, events } = captureLog();
    await runFlowConflictProbe({
      get: getReturning({
        [FLOW_API_PATH]: {},
        [ADVANCED_FLOW_API_PATH]: {
          adv: { cards: { c1: { id: `homey:device:${hoiaxId}:max_power_3000`, type: 'action' } } },
        },
      }),
      getSnapshot: () => [steppedDevice(hoiaxId, ['max_power_3000', 'onoff'])],
      structuredLog: logger,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'flow_conflict_probe',
      outcome: 'ok',
      candidateCount: 1,
      conflictCount: 1,
      conflicts: [{ deviceId: hoiaxId, capabilities: ['max_power_3000'] }],
    });
  });

  it('reports no conflict when the Flow only writes a non-owned capability (bridge pattern)', async () => {
    const { logger, events } = captureLog();
    await runFlowConflictProbe({
      get: getReturning({
        [FLOW_API_PATH]: {},
        [ADVANCED_FLOW_API_PATH]: {
          adv: { cards: { c1: { id: `homey:device:${hoiaxId}:installation_current_control`, type: 'action' } } },
        },
      }),
      getSnapshot: () => [steppedDevice(hoiaxId, ['max_power_3000', 'onoff'])],
      structuredLog: logger,
    });

    expect(events[0]).toMatchObject({ outcome: 'ok', candidateCount: 1, conflictCount: 0, conflicts: [] });
  });

  it('logs unknown and does not classify when the read fails closed', async () => {
    const { logger, events } = captureLog();
    await runFlowConflictProbe({
      get: async () => { throw new Error('403 Forbidden'); },
      getSnapshot: () => [steppedDevice(hoiaxId, ['max_power_3000'])],
      structuredLog: logger,
    });

    expect(events[0]).toMatchObject({ event: 'flow_conflict_probe', outcome: 'unknown' });
    expect(events[0]).not.toHaveProperty('conflictCount');
  });

  it('reports zero candidates when the snapshot has no native stepped devices', async () => {
    const { logger, events } = captureLog();
    await runFlowConflictProbe({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
      getSnapshot: () => [],
      structuredLog: logger,
    });

    expect(events[0]).toMatchObject({ outcome: 'ok', candidateCount: 0, conflictCount: 0 });
  });
});
