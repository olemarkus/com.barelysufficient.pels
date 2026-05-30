import {
  normalizeFlowCapabilityWrites,
  parseDeviceCapabilityWrite,
} from '../lib/flowApi/userFlows';
import {
  readFlowCapabilityWrites,
  FLOW_API_PATH,
  ADVANCED_FLOW_API_PATH,
  type FlowApiGet,
} from '../lib/flowApi/readUserFlows';

// Shapes mirror the real SHS Homey responses captured during PR1 design:
//  - flat flows  → { [flowId]: { trigger, conditions, actions } }
//  - advanced    → { [flowId]: { cards: { [cardId]: { ownerUri, id, args, type } } } }

const zaptecId = 'f6af914f-7aef-4b2a-b46f-691450f91431';
const easeeId = '30686557-7e69-4b1b-95b0-dfd0faa2d31e';
const lampId = '216f1324-482e-4409-9843-8ced7813f895';

// The write map is deviceId → capabilityId → (flowId → flowName). Most tests
// only care which capabilities a device carries; this collapses to that set.
const writtenCapabilities = (
  writes: ReturnType<typeof normalizeFlowCapabilityWrites>,
  deviceId: string,
): Set<string> => new Set(writes.get(deviceId)?.keys());

const flatFlowsFixture = {
  'flow-cozy': {
    trigger: { uri: 'homey:flowcardtrigger:homey:manager:flow:programmatic_trigger', id: 'homey:manager:flow:programmatic_trigger', args: {} },
    conditions: [],
    actions: [
      { uri: `homey:flowcardaction:homey:device:${lampId}:dim`, id: `homey:device:${lampId}:dim`, args: { dim: 0.1 } },
      { uri: 'homey:flowcardaction:homey:manager:mobile:push_text', id: 'homey:manager:mobile:push_text', args: {} },
    ],
  },
};

// "Zaptec stepped load": a PELS bridge trigger driving a Zaptec device action.
// "Easee stepped load": a Hoiax-style direct max_power write would look the
// same shape; here Easee gets a direct charging_button-equivalent write plus
// a PELS report action that must NOT count as a device-capability write.
const advancedFlowsFixture = {
  'adv-zaptec': {
    name: 'Zaptec stepped load',
    cards: {
      'card-trigger': {
        ownerUri: 'homey:app:com.barelysufficient.pels',
        id: 'homey:app:com.barelysufficient.pels:desired_stepped_load_changed',
        args: { device: { id: zaptecId, name: 'My Zaptec Charger' } },
        type: 'trigger',
      },
      'card-action': {
        ownerUri: `homey:device:${zaptecId}`,
        id: `homey:device:${zaptecId}:installation_current_control`,
        args: { current1: '[[x]]' },
        type: 'action',
      },
      'card-pels-report': {
        ownerUri: 'homey:app:com.barelysufficient.pels',
        id: 'homey:app:com.barelysufficient.pels:report_evcharger_battery_level',
        args: { device: { id: zaptecId, name: 'My Zaptec Charger' } },
        type: 'action',
      },
    },
  },
  'adv-easee': {
    name: 'Easee stepped load',
    cards: {
      'card-trigger': {
        ownerUri: 'homey:app:com.barelysufficient.pels',
        id: 'homey:app:com.barelysufficient.pels:desired_stepped_load_changed',
        args: { device: { id: easeeId, name: 'My Easee Charger' } },
        type: 'trigger',
      },
      'card-write': {
        ownerUri: `homey:device:${easeeId}`,
        id: `homey:device:${easeeId}:max_power_3000`,
        args: { value: '2' },
        type: 'action',
      },
    },
  },
};

describe('parseDeviceCapabilityWrite', () => {
  it('extracts deviceId + capabilityId from a device card id', () => {
    expect(parseDeviceCapabilityWrite(`homey:device:${zaptecId}:charging_button`)).toEqual({
      deviceId: zaptecId,
      capabilityId: 'charging_button',
    });
  });

  it('keeps dotted capability ids intact', () => {
    expect(parseDeviceCapabilityWrite(`homey:device:${zaptecId}:alarm_generic.car_connected`)).toEqual({
      deviceId: zaptecId,
      capabilityId: 'alarm_generic.car_connected',
    });
  });

  it('ignores PELS-app, manager, malformed, and non-string ids', () => {
    expect(parseDeviceCapabilityWrite('homey:app:com.barelysufficient.pels:desired_stepped_load_changed')).toBeNull();
    expect(parseDeviceCapabilityWrite('homey:manager:mobile:push_text')).toBeNull();
    expect(parseDeviceCapabilityWrite(`homey:device:${zaptecId}`)).toBeNull();
    expect(parseDeviceCapabilityWrite('homey:device::onoff')).toBeNull();
    expect(parseDeviceCapabilityWrite(undefined)).toBeNull();
    expect(parseDeviceCapabilityWrite(42)).toBeNull();
  });
});

describe('normalizeFlowCapabilityWrites', () => {
  it('collects device-capability writes from both flat and advanced flows', () => {
    const writes = normalizeFlowCapabilityWrites(flatFlowsFixture, advancedFlowsFixture);

    expect(writtenCapabilities(writes, lampId)).toEqual(new Set(['dim']));
    expect(writtenCapabilities(writes, zaptecId)).toEqual(new Set(['installation_current_control']));
    expect(writtenCapabilities(writes, easeeId)).toEqual(new Set(['max_power_3000']));
  });

  it('records the writing flow id and name per capability', () => {
    const writes = normalizeFlowCapabilityWrites(flatFlowsFixture, advancedFlowsFixture);

    // Advanced flow carries a name; the flat flow ('flow-cozy') has none → ''.
    expect(writes.get(easeeId)?.get('max_power_3000')).toEqual(new Map([['adv-easee', 'Easee stepped load']]));
    expect(writes.get(zaptecId)?.get('installation_current_control'))
      .toEqual(new Map([['adv-zaptec', 'Zaptec stepped load']]));
    expect(writes.get(lampId)?.get('dim')).toEqual(new Map([['flow-cozy', '']]));
  });

  it('ignores triggers, conditions, PELS-app actions, and manager actions', () => {
    const writes = normalizeFlowCapabilityWrites(flatFlowsFixture, advancedFlowsFixture);
    // The PELS report_evcharger_battery_level action and the bridge triggers
    // are not device-capability writes, so zaptec must only carry the one
    // real device write.
    expect(writtenCapabilities(writes, zaptecId)).toEqual(new Set(['installation_current_control']));
    // The manager push_text action contributes no device.
    expect([...writes.keys()].sort()).toEqual([lampId, easeeId, zaptecId].sort());
  });

  it('merges multiple writes to the same device across flows', () => {
    const writes = normalizeFlowCapabilityWrites(
      {},
      {
        a: { name: 'Flow A', cards: { c1: { id: `homey:device:${easeeId}:max_power_3000`, type: 'action' } } },
        b: { name: 'Flow B', cards: { c2: { id: `homey:device:${easeeId}:onoff`, type: 'action' } } },
      },
    );
    expect(writtenCapabilities(writes, easeeId)).toEqual(new Set(['max_power_3000', 'onoff']));
    // Each capability records its own writing flow.
    expect(writes.get(easeeId)?.get('max_power_3000')).toEqual(new Map([['a', 'Flow A']]));
    expect(writes.get(easeeId)?.get('onoff')).toEqual(new Map([['b', 'Flow B']]));
  });

  it('returns an empty map for empty inputs', () => {
    expect(normalizeFlowCapabilityWrites({}, {}).size).toBe(0);
  });

  it('ignores disabled flows (enabled === false) in both shapes', () => {
    const disabledFlat = {
      'flow-off': {
        enabled: false,
        actions: [{ id: `homey:device:${easeeId}:max_power_3000` }],
      },
    };
    const disabledAdvanced = {
      'adv-off': {
        enabled: false,
        cards: { c1: { id: `homey:device:${zaptecId}:max_power_3000`, type: 'action' } },
      },
    };
    expect(normalizeFlowCapabilityWrites(disabledFlat, disabledAdvanced).size).toBe(0);
  });

  it('treats a missing enabled field as active (conflict-safe default)', () => {
    const writes = normalizeFlowCapabilityWrites(
      { 'flow-x': { actions: [{ id: `homey:device:${easeeId}:onoff` }] } },
      {},
    );
    expect(writtenCapabilities(writes, easeeId)).toEqual(new Set(['onoff']));
  });

  it('skips malformed flow / card entries without throwing', () => {
    const writes = normalizeFlowCapabilityWrites(
      { bad: null, worse: { actions: 'nope' } } as unknown as Record<string, unknown>,
      { bad: { cards: null }, worse: 7 } as unknown as Record<string, unknown>,
    );
    expect(writes.size).toBe(0);
  });
});

describe('readFlowCapabilityWrites (fail-closed)', () => {
  const okGet = (responses: Record<string, unknown>): FlowApiGet => async (path) => {
    if (path in responses) return responses[path];
    throw new Error(`unexpected path ${path}`);
  };

  it('returns status ok with the merged write map when both endpoints read', async () => {
    const result = await readFlowCapabilityWrites({
      get: okGet({ [FLOW_API_PATH]: flatFlowsFixture, [ADVANCED_FLOW_API_PATH]: advancedFlowsFixture }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(new Set(result.writes.get(zaptecId)?.keys())).toEqual(new Set(['installation_current_control']));
  });

  it('distinguishes read-ok-but-empty from unknown', async () => {
    const result = await readFlowCapabilityWrites({
      get: okGet({ [FLOW_API_PATH]: {}, [ADVANCED_FLOW_API_PATH]: {} }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.writes.size).toBe(0);
  });

  it('returns unknown when the flat endpoint throws (e.g. 403 / transport error)', async () => {
    const result = await readFlowCapabilityWrites({
      get: async (path) => {
        if (path === FLOW_API_PATH) throw new Error('403 Forbidden');
        return {};
      },
    });
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.reason).toContain('403');
  });

  it('returns unknown when the advanced endpoint throws even if flat read', async () => {
    const result = await readFlowCapabilityWrites({
      get: async (path) => {
        if (path === ADVANCED_FLOW_API_PATH) throw new Error('socket hang up');
        return {};
      },
    });
    expect(result.status).toBe('unknown');
  });

  it('returns unknown when an endpoint returns a non-object body', async () => {
    const result = await readFlowCapabilityWrites({
      get: okGet({ [FLOW_API_PATH]: 'not json', [ADVANCED_FLOW_API_PATH]: {} }),
    });
    expect(result.status).toBe('unknown');
  });
});
