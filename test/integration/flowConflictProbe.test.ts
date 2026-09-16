import { detectNativeWiringConflicts } from '../../setup/flowConflictProbe';
import { FLOW_API_PATH, ADVANCED_FLOW_API_PATH, type FlowApiGet } from '../../lib/flowApi/readUserFlows';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { Logger as PinoLogger } from 'pino';

const hoiaxId = 'hoiax-1';
const targetPowerId = 'tp-1';
const easeeId = 'easee-1';
const easeeNativeWrites = ['target_charger_current', 'setDynamicChargerCurrent'];

const candidateDevice = (id: string, nativeWriteCapabilities: string[]): TargetDeviceSnapshot => ({
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

const advancedWrite = (deviceId: string, capabilityId: string) => ({
  adv: { cards: { c1: { id: `homey:device:${deviceId}:${capabilityId}`, type: 'action' } } },
});

describe('detectNativeWiringConflicts', () => {
  it('auto-enables a Hoiax candidate with no conflicting Flow', async () => {
    const { logger, events } = captureLog();
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
      getDescriptors: () => [candidateDevice(hoiaxId, ['max_power_3000', 'onoff'])],
      structuredLog: logger,
    });

    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [hoiaxId], conflicts: [] });
    expect(events[0]).toMatchObject({ outcome: 'ok', candidateCount: 1, conflictCount: 0, autoEnableCount: 1 });
  });

  it('excludes a Hoiax device whose owned capability a Flow writes, and reports the conflict', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: advancedWrite(hoiaxId, 'max_power_3000') }),
      getDescriptors: () => [candidateDevice(hoiaxId, ['max_power_3000', 'onoff'])],
    });
    expect(result).toEqual({
      status: 'ok',
      autoEnableDeviceIds: [],
      conflicts: [{ deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000'] }],
    });
  });

  it('keeps auto-enabling when the Flow only writes a non-owned capability (bridge pattern)', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({
        [FLOW_API_PATH]: {},
        [ADVANCED_FLOW_API_PATH]: advancedWrite(hoiaxId, 'installation_current_control'),
      }),
      getDescriptors: () => [candidateDevice(hoiaxId, ['max_power_3000', 'onoff'])],
    });
    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [hoiaxId], conflicts: [] });
  });

  it('auto-enables an Easee charger with no Flow setting its current', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
      getDescriptors: () => [candidateDevice(easeeId, easeeNativeWrites)],
    });
    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [easeeId], conflicts: [] });
  });

  it('holds an Easee charger on the Flow when a Flow uses the app\'s dynamic current card', async () => {
    // The production bridge Flow: PELS' stepped-load trigger drives Easee's
    // "Set dynamic charger current" card, which is the same write as the
    // capability, so it is a conflict and names the Flow.
    const result = await detectNativeWiringConflicts({
      get: getReturning({
        [FLOW_API_PATH]: {},
        [ADVANCED_FLOW_API_PATH]: {
          adv: {
            name: 'Elbillader',
            cards: {
              trigger: { id: 'homey:app:com.barelysufficient.pels:desired_stepped_load_changed', type: 'trigger' },
              readback: { id: `homey:device:${easeeId}:target_charger_current_changed`, type: 'trigger' },
              set: { id: `homey:device:${easeeId}:setDynamicChargerCurrent`, type: 'action' },
              report: { id: 'homey:app:com.barelysufficient.pels:report_stepped_load_power', type: 'action' },
            },
          },
        },
      }),
      getDescriptors: () => [candidateDevice(easeeId, easeeNativeWrites)],
    });
    expect(result).toEqual({
      status: 'ok',
      autoEnableDeviceIds: [],
      conflicts: [{ deviceId: easeeId, conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'Elbillader' }],
    });
  });

  it('does not auto-enable target_power steppers (already default-on, out of scope)', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
      getDescriptors: () => [candidateDevice(targetPowerId, ['target_power'])],
    });
    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [], conflicts: [] });
  });

  it('does not surface a conflict for an always-on target_power device (no false banner)', async () => {
    // target_power is default-on with its toggle hidden, so a conflict there
    // must not be surfaced — the banner would otherwise claim control was
    // "left off" with a switch that does not exist.
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: advancedWrite(targetPowerId, 'target_power') }),
      getDescriptors: () => [candidateDevice(targetPowerId, ['target_power'])],
    });
    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [], conflicts: [] });
  });

  it('returns unknown and no decisions when the flow read fails closed', async () => {
    const { logger, events } = captureLog();
    const result = await detectNativeWiringConflicts({
      get: async () => { throw new Error('403 Forbidden'); },
      getDescriptors: () => [candidateDevice(hoiaxId, ['max_power_3000'])],
      structuredLog: logger,
    });
    expect(result).toEqual({ status: 'unknown' });
    expect(events[0]).toMatchObject({ event: 'flow_conflict_detection', outcome: 'unknown' });
  });

  it('returns no Easee decision when an object-shaped Flow response is malformed', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({
        [FLOW_API_PATH]: {},
        [ADVANCED_FLOW_API_PATH]: { partial: { cards: null } },
      }),
      getDescriptors: () => [candidateDevice(easeeId, easeeNativeWrites)],
    });

    expect(result).toEqual({ status: 'unknown' });
  });

  it('returns no decisions when the snapshot has no candidates', async () => {
    const result = await detectNativeWiringConflicts({
      get: getReturning({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
      getDescriptors: () => [],
    });
    expect(result).toEqual({ status: 'ok', autoEnableDeviceIds: [], conflicts: [] });
  });
});
