// The battery control owner as one layer: claim admission, the durable claim
// record and every hand-back lane. Its outward seams — the settings store, the
// actuator's storage intents, the battery and membership reads, and the clock —
// are doubles. The same owner over the real transport is covered in
// homeBatteryClaimLifecycle.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATTERY_RELEASE_RETRY_BACKOFF_MS,
  HomeBatteryControlOwner,
  type BatteryControlRead,
} from '../../lib/battery/batteryControlOwner';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { StorageCommand } from '../../lib/ports/storageCommand';
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import { BATTERY_CONTROL_DEVICES, PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import { captureLogger } from '../utils/loggerCapture';

const BATTERY = 'battery-1';
const OTHER = 'battery-2';
const CLAIM_KEY = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${BATTERY}`;
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

const settingsStore = (initial: Record<string, unknown> = {}): SettingsPort => {
  const values = new Map<string, unknown>([['capacity_limit_kw', 10], ...Object.entries(initial)]);
  return {
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
    getKeys: () => [...values.keys()],
  };
};

const setpointBattery = (claimValue: string, observedAtMs = T0 - 60_000): BatteryControlRead => ({
  kind: 'setpoint',
  surface: {
    kind: 'setpoint',
    claim: { capabilityId: 'target_power_mode', homeyValue: 'homey', values: ['homey', 'anti_feed', 'manual'] },
    range: { minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  },
  claim: { value: claimValue, observedAtMs },
});

const record = (previousValue: string, claimedAtMs = T0 - 3_600_000) => ({
  capabilityId: 'target_power_mode',
  previousValue,
  claimedAtMs,
});

const refresh = (...deviceIds: string[]): ObservedDeviceStateRefreshPayload => ({
  entries: deviceIds.map((id) => ({ observationSeq: 1, observedAtMs: T0, observed: { id } as ObservedDeviceState })),
});

const buildOwner = (params: {
  settings?: SettingsPort;
  batteries?: Record<string, BatteryControlRead>;
  mainMember?: boolean;
  fenced?: boolean;
  dryRun?: boolean;
  apply?: (command: StorageCommand) => Promise<{ requested: boolean }>;
} = {}) => {
  const settings = params.settings ?? settingsStore();
  const batteries: Record<string, BatteryControlRead> = params.batteries ?? { [BATTERY]: setpointBattery('anti_feed') };
  const commands: StorageCommand[] = [];
  const owner = new HomeBatteryControlOwner({
    settings,
    actuation: {
      apply: async (command) => {
        commands.push(command);
        return params.apply ? params.apply(command) : { requested: true };
      },
    },
    getBattery: (deviceId) => batteries[deviceId] ?? { kind: 'unobserved' },
    isMainHomeMember: () => params.mainMember ?? true,
    isActuationFenced: () => params.fenced ?? false,
    isCapacityDryRun: () => params.dryRun ?? false,
  });
  return { owner, settings, commands, batteries };
};

/** Let the owner's hand-back promises run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeBatteryControlOwner admission', () => {
  it('records the observed claim value and the claim time before admitting, and only once', () => {
    const { owner, settings } = buildOwner();

    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    expect(settings.get(CLAIM_KEY)).toEqual(record('anti_feed', T0));

    vi.setSystemTime(T0 + 10_000);
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    expect(settings.get(CLAIM_KEY)).toEqual(record('anti_feed', T0));
  });

  it.each([
    { name: 'a battery PELS can only observe', params: {
      batteries: { [BATTERY]: { kind: 'observe_only' } },
    }, reason: 'not_drivable' },
    { name: 'a battery that is not observed', params: { batteries: {} }, reason: 'not_drivable' },
    { name: 'an opted-out battery', params: {
      settings: settingsStore({ [BATTERY_CONTROL_DEVICES]: { [BATTERY]: false } }),
    }, reason: 'control_disabled' },
    { name: 'an unreadable opt-out', params: {
      settings: settingsStore({ [BATTERY_CONTROL_DEVICES]: 'junk' }),
    }, reason: 'control_setting_unreadable' },
    { name: 'a meter-area battery', params: { mainMember: false }, reason: 'not_main_home' },
    { name: 'a fenced Main', params: { fenced: true }, reason: 'actuation_fenced' },
    { name: 'capacity simulation', params: { dryRun: true }, reason: 'dry_run' },
    { name: 'a battery already under Homey\'s claim with no record', params: {
      batteries: { [BATTERY]: setpointBattery('homey') },
    }, reason: 'held_by_other' },
    { name: 'a pre-claim value the battery does not declare', params: {
      batteries: { [BATTERY]: setpointBattery('device') },
    }, reason: 'claim_value_undeclared' },
    { name: 'a battery that has not reported its claim', params: {
      batteries: { [BATTERY]: { ...setpointBattery('anti_feed'), claim: { kind: 'unreported' } } },
    }, reason: 'claim_unobserved' },
    { name: 'its own unreadable record', params: {
      settings: settingsStore({ [CLAIM_KEY]: { capabilityId: 'target_power_mode' } }),
    }, reason: 'claim_record_unreadable' },
  ] as const)('refuses $name without recording anything', ({ params, reason }) => {
    const { owner, settings } = buildOwner(params as Parameters<typeof buildOwner>[0]);
    const before = settings.get(CLAIM_KEY);
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason });
    expect(settings.get(CLAIM_KEY)).toEqual(before);
  });

  it('reads an opt-out that did not read cleanly again at the next admission', () => {
    const settings = settingsStore({ [BATTERY_CONTROL_DEVICES]: 'junk' });
    const { owner } = buildOwner({ settings });
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'control_setting_unreadable' });

    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: true });
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
  });

  it('keeps a junk record to its own battery: another battery is still admitted and handed back', async () => {
    const { owner, settings, commands } = buildOwner({
      settings: settingsStore({ [CLAIM_KEY]: 'junk' }),
      batteries: { [BATTERY]: setpointBattery('homey'), [OTHER]: setpointBattery('manual') },
    });

    expect(owner.admitClaim(OTHER)).toEqual({ status: 'admitted' });
    settings.set(BATTERY_CONTROL_DEVICES, { [OTHER]: false });
    owner.applyControlSettings();
    await settle();

    expect(commands).toEqual([{ kind: 'storage_release', deviceId: OTHER, restoreClaimValue: 'manual' }]);
    expect(settings.get(CLAIM_KEY)).toBe('junk');
  });
});

describe('HomeBatteryControlOwner hand-back', () => {
  it('hands back an opted-out battery and drops its record', async () => {
    const { owner, settings, commands, batteries } = buildOwner();
    owner.admitClaim(BATTERY);
    batteries[BATTERY] = setpointBattery('homey', T0 + 1_000);

    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await settle();

    expect(commands).toEqual([{ kind: 'storage_release', deviceId: BATTERY, restoreClaimValue: 'anti_feed' }]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('hands back a battery whose snapshot still shows the pre-claim value from before the claim', async () => {
    const { owner, settings, commands } = buildOwner();
    owner.admitClaim(BATTERY);

    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await settle();

    expect(commands).toEqual([{ kind: 'storage_release', deviceId: BATTERY, restoreClaimValue: 'anti_feed' }]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('drops the record without writing when someone else took the battery over after the claim', async () => {
    const { owner, settings, commands, batteries } = buildOwner();
    owner.admitClaim(BATTERY);
    batteries[BATTERY] = setpointBattery('manual', T0 + 5_000);

    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await settle();

    expect(commands).toEqual([]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('retries a failed opt-out hand-back on committed snapshots, with backoff', async () => {
    let accept = false;
    const { owner, settings, commands } = buildOwner({
      apply: async () => {
        if (!accept) throw new Error('Mock capability write rejected');
        return { requested: true };
      },
    });
    owner.admitClaim(BATTERY);
    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await settle();
    expect(commands).toHaveLength(1);

    // Not due yet: the first retry waits a minute.
    owner.onSnapshotCommitted(refresh(BATTERY));
    await settle();
    expect(commands).toHaveLength(1);

    vi.setSystemTime(T0 + BATTERY_RELEASE_RETRY_BACKOFF_MS[0]);
    owner.onSnapshotCommitted(refresh(BATTERY));
    await settle();
    expect(commands).toHaveLength(2);

    // The second failure backs off further.
    vi.setSystemTime(T0 + BATTERY_RELEASE_RETRY_BACKOFF_MS[0] * 2);
    owner.onSnapshotCommitted(refresh(BATTERY));
    await settle();
    expect(commands).toHaveLength(2);

    accept = true;
    vi.setSystemTime(T0 + BATTERY_RELEASE_RETRY_BACKOFF_MS[0] + BATTERY_RELEASE_RETRY_BACKOFF_MS[1]);
    owner.onSnapshotCommitted(refresh(BATTERY));
    await settle();
    expect(commands).toHaveLength(3);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('recovers a claim a previous run left once the battery is observed', async () => {
    const batteries: Record<string, BatteryControlRead> = {};
    const { owner, settings, commands } = buildOwner({
      settings: settingsStore({ [CLAIM_KEY]: record('manual') }),
      batteries,
    });

    owner.onSnapshotCommitted(refresh(OTHER));
    await settle();
    expect(commands).toEqual([]);

    batteries[BATTERY] = setpointBattery('homey');
    owner.onSnapshotCommitted(refresh(BATTERY, OTHER));
    await settle();
    expect(commands).toEqual([{ kind: 'storage_release', deviceId: BATTERY, restoreClaimValue: 'manual' }]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('stops on a terminal failure: no write, one log, the record kept', async () => {
    const logs = captureLogger('info');
    const { owner, settings, commands } = buildOwner({
      // Recorded against a value this battery does not declare.
      settings: settingsStore({ [CLAIM_KEY]: record('device') }),
      batteries: { [BATTERY]: setpointBattery('homey') },
    });

    for (let hour = 0; hour < 3; hour += 1) {
      vi.setSystemTime(T0 + hour * 3_600_000);
      owner.onSnapshotCommitted(refresh(BATTERY));
      await settle();
    }

    expect(commands).toEqual([]);
    expect(settings.get(CLAIM_KEY)).toEqual(record('device'));
    expect(logs.findEvents('battery_control_release_failed')).toEqual([expect.objectContaining({
      deviceId: BATTERY, failure: 'restore_value_undeclared', terminal: true,
    })]);
    logs.restore();
  });

  it('adopts a previous run\'s claim on admission instead of handing it back', async () => {
    const { owner, settings, commands } = buildOwner({
      settings: settingsStore({ [CLAIM_KEY]: record('manual') }),
      batteries: { [BATTERY]: setpointBattery('homey') },
    });

    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    owner.onSnapshotCommitted(refresh(BATTERY));
    await settle();

    expect(commands).toEqual([]);
    expect(settings.get(CLAIM_KEY)).toEqual(record('manual'));
  });

  it('prunes the record of a battery missing from two complete refreshes in a row, never on an empty one', async () => {
    const { owner, settings } = buildOwner({
      settings: settingsStore({ [CLAIM_KEY]: record('manual') }),
      batteries: {},
    });

    owner.onSnapshotCommitted(refresh(OTHER));
    owner.onSnapshotCommitted(refresh());
    owner.onSnapshotCommitted(refresh());
    expect(settings.get(CLAIM_KEY)).not.toBeNull();
    // Seen again: the count starts over.
    owner.onSnapshotCommitted(refresh(BATTERY));
    owner.onSnapshotCommitted(refresh(OTHER));
    expect(settings.get(CLAIM_KEY)).not.toBeNull();

    const logs = captureLogger('info');
    owner.onSnapshotCommitted(refresh(OTHER));
    expect(settings.get(CLAIM_KEY)).toBeNull();
    expect(logs.findEvent('battery_control_claim_pruned')).toMatchObject({ deviceId: BATTERY, reason: 'device_removed' });
    logs.restore();
  });
});
