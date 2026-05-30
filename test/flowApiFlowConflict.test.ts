import { resolveFlowConflict, classifyFlowConflicts } from '../lib/flowApi/flowConflict';
import type { FlowCapabilityWrites } from '../lib/flowApi/userFlows';

// Each capability is written by a single unnamed default Flow, so conflict
// detection works while flow-name resolution stays absent (empty name → no
// `flowName`). Flow-naming behavior is exercised by `writesWithFlows` below.
const writesOf = (entries: Record<string, string[]>): FlowCapabilityWrites => (
  new Map(Object.entries(entries).map(([id, caps]) => [
    id,
    new Map(caps.map((cap) => [cap, new Map([['flow-default', '']])])),
  ]))
);

// deviceId → capabilityId → [flowId, flowName][] — for exercising which Flow(s)
// a conflict's capabilities are attributed to.
const writesWithFlows = (
  entries: Record<string, Record<string, Array<[string, string]>>>,
): FlowCapabilityWrites => (
  new Map(Object.entries(entries).map(([deviceId, caps]) => [
    deviceId,
    new Map(Object.entries(caps).map(([cap, flows]) => [cap, new Map(flows)])),
  ]))
);

const hoiaxId = 'hoiax-1';
const zaptecId = 'zaptec-1';
const easeeId = 'easee-1';

describe('resolveFlowConflict', () => {
  it('returns the capabilities written by both a Flow and PELS', () => {
    const writes = writesOf({ [hoiaxId]: ['max_power_3000', 'measure_power'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000', 'max_power_2000', 'max_power', 'onoff']))
      .toEqual(['max_power_3000']);
  });

  it('returns every overlapping capability, not just the first', () => {
    const writes = writesOf({ [hoiaxId]: ['max_power_3000', 'onoff'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000', 'max_power_2000', 'max_power', 'onoff']))
      .toEqual(['max_power_3000', 'onoff']);
  });

  it('returns empty when the device has no Flow writes', () => {
    const writes = writesOf({ [zaptecId]: ['charging_button'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000'])).toEqual([]);
  });

  it('returns empty when Flow writes exist but none overlap the owned set', () => {
    const writes = writesOf({ [zaptecId]: ['target_temperature', 'measure_power'] });
    expect(resolveFlowConflict(writes, zaptecId, ['charging_button'])).toEqual([]);
  });

  it('returns empty for an empty owned-capability set', () => {
    const writes = writesOf({ [zaptecId]: ['charging_button'] });
    expect(resolveFlowConflict(writes, zaptecId, [])).toEqual([]);
  });

  it('detects a single-capability owned set (target_power) as a conflict', () => {
    const writes = writesOf({ [easeeId]: ['target_power', 'measure_power'] });
    expect(resolveFlowConflict(writes, easeeId, ['target_power'])).toEqual(['target_power']);
  });

  it('preserves owned-set ordering and de-duplicates a repeated owned capability', () => {
    const writes = writesOf({ [hoiaxId]: ['onoff', 'max_power'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['onoff', 'max_power', 'onoff']))
      .toEqual(['onoff', 'max_power']);
  });
});

describe('classifyFlowConflicts', () => {
  it('returns one entry per conflicted device and omits clean ones', () => {
    const writes = writesOf({
      [hoiaxId]: ['max_power_3000'],
      [zaptecId]: ['installation_current_control'], // bridge write, not a native-owned cap
      [easeeId]: ['onoff'],
    });
    const result = classifyFlowConflicts(writes, [
      { deviceId: hoiaxId, ownedCapabilities: ['max_power_3000', 'max_power_2000', 'max_power', 'onoff'] },
      { deviceId: zaptecId, ownedCapabilities: ['charging_button'] },
      { deviceId: easeeId, ownedCapabilities: ['onoff'] },
    ]);
    expect(result).toEqual([
      { deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000'] },
      { deviceId: easeeId, conflictingCapabilities: ['onoff'] },
    ]);
  });

  it('returns an empty array when no candidate device conflicts', () => {
    const writes = writesOf({ [zaptecId]: ['installation_current_control'] });
    const result = classifyFlowConflicts(writes, [
      { deviceId: zaptecId, ownedCapabilities: ['charging_button'] },
    ]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for no candidate devices', () => {
    expect(classifyFlowConflicts(writesOf({ [hoiaxId]: ['max_power'] }), [])).toEqual([]);
  });
});

describe('classifyFlowConflicts flow naming', () => {
  const owned = ['max_power_3000', 'max_power_2000', 'max_power', 'onoff'];

  it('names the single Flow responsible for the conflict', () => {
    const writes = writesWithFlows({ [hoiaxId]: { max_power_3000: [['f1', 'Charge at night']] } });
    expect(classifyFlowConflicts(writes, [{ deviceId: hoiaxId, ownedCapabilities: owned }])).toEqual([
      { deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000'], flowName: 'Charge at night' },
    ]);
  });

  it('names the Flow once even when it writes two conflicting capabilities', () => {
    const writes = writesWithFlows({
      [hoiaxId]: { max_power_3000: [['f1', 'Night heat']], onoff: [['f1', 'Night heat']] },
    });
    const [conflict] = classifyFlowConflicts(writes, [{ deviceId: hoiaxId, ownedCapabilities: owned }]);
    expect(conflict.flowName).toBe('Night heat');
  });

  it('does not name when two distinct Flows each write a conflicting capability', () => {
    const writes = writesWithFlows({
      [hoiaxId]: { max_power_3000: [['f1', 'Flow A']], onoff: [['f2', 'Flow B']] },
    });
    expect(classifyFlowConflicts(writes, [{ deviceId: hoiaxId, ownedCapabilities: owned }])).toEqual([
      { deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000', 'onoff'] },
    ]);
  });

  it('does not name when two distinct Flows write the same conflicting capability', () => {
    const writes = writesWithFlows({
      [hoiaxId]: { max_power_3000: [['f1', 'Flow A'], ['f2', 'Flow B']] },
    });
    const [conflict] = classifyFlowConflicts(writes, [{ deviceId: hoiaxId, ownedCapabilities: owned }]);
    expect(conflict.flowName).toBeUndefined();
  });

  it('does not name when the single responsible Flow has no usable name', () => {
    const writes = writesWithFlows({ [hoiaxId]: { max_power_3000: [['f1', '']] } });
    const [conflict] = classifyFlowConflicts(writes, [{ deviceId: hoiaxId, ownedCapabilities: owned }]);
    expect(conflict.flowName).toBeUndefined();
    expect(conflict).toEqual({ deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000'] });
  });
});
