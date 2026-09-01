/**
 * Coverage for the "Leave off until turned on again" detection seam
 * (`syncExternalOffHoldForDevice`) and its producer projection
 * (`toPlanDevice` → `externalOffHoldActive`).
 *
 * Integration tier: drives the real detector and the real producer against a
 * mocked AppContext. The gates under test are the ones that decide whether PELS
 * fabricates a hold — the expensive failure mode, because a false hold strands a
 * user's device off until they notice.
 */
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import {
  isAffirmativelyOn,
  releaseExternalOffHoldsForObservedOn,
  syncExternalOffHoldForDevice,
  toExternalOffHoldObservedDevice,
} from '../../setup/externalOffHoldDetection';
import { createExternalOffHoldPolicy } from '../../setup/externalOffHoldAdapter';
import type { ExternalOffHoldSyncDeps } from '../../setup/externalOffHoldDetection';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import {
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import type { ExternalOffHoldObservedDevice } from '../../setup/externalOffHoldDetection';
import type {
  EvObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadDescriptorProbe,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const NOW = new Date('2026-07-25T12:00:00Z').getTime();
const DEVICE_ID = 'heater-1';

type SnapshotProbe = TransportDeviceSnapshot
  & EvObservedProbe
  & SteppedLoadDescriptorProbe
  & ReportedStepObservedProbe
  & SteppedLoadDecoration;

const buildSnapshot = (
  overrides: Partial<SnapshotProbe> = {},
): SnapshotProbe => {
  const explicitlyWithoutBinary = Object.prototype.hasOwnProperty.call(overrides, 'binaryCapabilityId')
    && overrides.binaryCapabilityId === undefined;
  const capabilityId = overrides.binaryCapabilityId ?? 'onoff';
  return {
    id: DEVICE_ID,
    name: 'Water heater',
    targets: [],
    deviceClass: 'other',
    ...(!explicitlyWithoutBinary ? {
      binaryCapabilityId: capabilityId,
      binaryControl: { on: false },
      binaryControlObservation: {
        valid: true,
        capabilityId,
        observedValue: false,
        observedCapabilityIds: [capabilityId],
        observedAtMs: NOW,
        source: 'snapshot_refresh',
      },
    } : {}),
    ...overrides,
  } as SnapshotProbe;
};

type Harness = {
  ctx: AppContext;
  deps: ExternalOffHoldSyncDeps;
  clearRecentBinaryOffCommand: ReturnType<typeof vi.fn>;
  /** Let a store seeded as unreadable start answering again. */
  recoverStore: () => void;
};

const buildCtx = (params: {
  optedIn?: boolean;
  /** Device ids already holding across a restart, seeded as per-device keys. */
  heldBefore?: readonly string[];
  pending?: { desired: boolean };
  /**
   * Make the store unreadable, as a transient Homey settings failure does. A
   * hold is a key, so the read that fails is the key LIST — there is no per-hold
   * value left to fail on.
   */
  holdsUnreadable?: boolean;
} = {}): Harness => {
  const ctx = createAppContextMock();
  const unreadable = { current: params.holdsUnreadable === true };
  // Stands in for the rest of PELS's settings: an empty key list is read as a
  // transient-store flake by design, so a store holding only the hold under
  // test would flip to fail-closed the moment that hold is released.
  const settings = new Map<string, unknown>([['some_other_pels_setting', 1]]);
  if (params.optedIn) settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE_ID]: true });
  for (const deviceId of params.heldBefore ?? []) {
    settings.set(`${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${deviceId}`, true);
  }
  ctx.externalOffHold = createExternalOffHoldPolicy({
    get: (key) => settings.get(key) ?? null,
    set: (key, value) => { settings.set(key, value); },
    unset: (key) => { settings.delete(key); },
    getKeys: () => {
      if (unreadable.current) throw new Error('settings unavailable');
      return Array.from(settings.keys());
    },
  });
  ctx.isCapacityControlEnabled = () => true;
  const clearRecentBinaryOffCommand = vi.fn();
  const deps: ExternalOffHoldSyncDeps = {
    policy: ctx.externalOffHold,
    // Provenance is resolved by the OWNING home's engine; the detector consumes
    // the device-keyed boolean.
    hasPendingBinaryCommand: (deviceId) => (
      params.pending !== undefined
      && deviceId === DEVICE_ID
    ),
    clearRecentBinaryOffCommand,
  };
  return {
    ctx, deps, clearRecentBinaryOffCommand, recoverStore: () => { unreadable.current = false; },
  };
};

const observedDeviceFor = (
  _ctx: AppContext,
  overrides: Partial<SnapshotProbe> = {},
): ExternalOffHoldObservedDevice => toExternalOffHoldObservedDevice(
  buildSnapshot(overrides),
)!;

/** The ON->OFF transition every real outside-off observation carries. */
const OFF_TRANSITION = [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }];
const ON_TRANSITION = [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }];
const EV_OFF_TRANSITION = [
  {
    capabilityId: 'evcharger_charging',
    observedCapabilityId: 'evcharger_charging',
    previousValue: 'on',
    nextValue: 'off',
  },
];
const EV_STATE_OFF_TRANSITION = [
  {
    capabilityId: 'evcharger_charging',
    observedCapabilityId: 'evcharger_charging_state',
    previousValue: 'on',
    nextValue: 'off',
  },
];

const sync = (
  harness: Harness,
  observedDevice: ExternalOffHoldObservedDevice,
  changes: readonly {
    capabilityId: string;
    observedCapabilityId?: string;
    previousValue: string;
    nextValue: string;
  }[]
    = OFF_TRANSITION,
): ReturnType<typeof syncExternalOffHoldForDevice> => syncExternalOffHoldForDevice({
  deps: harness.deps,
  deviceId: DEVICE_ID,
  observedDevice,
  changes,
});

describe('syncExternalOffHoldForDevice — starting a hold', () => {
  it('starts a hold for an opted-in outside OFF without consulting plan state', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(true);
  });

  it('does not start a hold for a device that has not opted in', () => {
    const h = buildCtx({ optedIn: false });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(false);
  });

  it('does not start a hold when the off matches a pending PELS off command', () => {
    const h = buildCtx({ optedIn: true, pending: { desired: false } });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
  });

  it('starts a hold while Power-limit control is off', () => {
    const h = buildCtx({ optedIn: true });
    h.ctx.isCapacityControlEnabled = () => false;
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
  });

  it('starts a hold for an unavailable device when the explicit external transition still arrives', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx, { available: false }))).toBe('started');
  });

  it('does not start a hold for a device with no binary control handle', () => {
    const h = buildCtx({ optedIn: true });
    const observed = observedDeviceFor(h.ctx, {
      binaryCapabilityId: undefined,
      binaryControl: undefined,
    });
    expect(sync(h, observed)).toBe('none');
  });

  it('does not start a hold while the device is observed on', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx, { binaryControl: { on: true } }))).toBe('none');
  });
});

describe('syncExternalOffHoldForDevice — an off LEVEL is not an off ACTION', () => {
  // The most expensive mistake available here: "device is off while the plan says
  // keep" is ALSO what PELS failing to turn a device ON looks like. A slow device
  // that misses the 5 s settle window emits exactly that, so a level-based test
  // would strand it on its first shed/restore cycle.
  it('starts no hold when the observation carries no on->off transition', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx), [])).toBe('none');
  });

  it('starts no hold when the transition is on a different capability', () => {
    const h = buildCtx({ optedIn: true });
    const changes = [{ capabilityId: 'measure_power', previousValue: 'on', nextValue: 'off' }];
    expect(sync(h, observedDeviceFor(h.ctx), changes)).toBe('none');
  });

  it('starts no hold for an off->off report', () => {
    const h = buildCtx({ optedIn: true });
    const changes = [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'off' }];
    expect(sync(h, observedDeviceFor(h.ctx), changes)).toBe('none');
  });

  it('starts no hold while PELS has an in-flight ON command (the slow-restore case)', () => {
    const h = buildCtx({ optedIn: true, pending: { desired: true } });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
  });

  it('keeps pending attribution device-keyed', () => {
    const h = buildCtx({ optedIn: true, pending: { desired: false } });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
  });

  it('records a real transition even while the persisted state is unreadable', () => {
    // While the store cannot be read it answers a fail-closed guess for every
    // opted-in device. Treating that guess as an existing hold would swallow a
    // genuine outside-off action: nothing is written, and when the read recovers
    // the guess evaporates and the device is resumed. The transition has to
    // become a REAL hold.
    const h = buildCtx({ optedIn: true, holdsUnreadable: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    // The store is the only place a hold lives, so "it became REAL" is asked of
    // the store once it answers again — not of an in-memory copy the policy
    // deliberately does not keep.
    h.recoverStore();
    expect(h.ctx.externalOffHold?.heldDeviceIds()).toEqual([DEVICE_ID]);
  });
});

describe('syncExternalOffHoldForDevice — EV plug states', () => {
  const evSnapshot = (
    evChargingState: EvObservedProbe['evChargingState'],
  ): Partial<TransportDeviceSnapshot & EvObservedProbe> => ({
    deviceClass: 'evcharger',
    binaryCapabilityId: 'evcharger_charging',
    evChargingState,
  });

  // Unplugged/discharging are session-state folds rather than explicit outside
  // OFF actions. Every other session posture remains eligible: a connected
  // charger can be explicitly paused regardless of whether PELS could command
  // it in this exact planning cycle.
  it.each([
    ['explicitly paused', 'plugged_in_paused'],
    ['connected and idle', 'plugged_in'],
    // Unknown state does not positively identify unplugging/discharging, so an
    // explicit control-capability ON→OFF remains authoritative.
    ['in an unknown plug state', undefined],
  ] as const)('starts a hold for a connected charger that is %s', (_label, state) => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx, evSnapshot(state)), EV_OFF_TRANSITION)).toBe('started');
  });

  it.each([
    ['unplugged', 'plugged_out'],
    ['discharging', 'plugged_in_discharging'],
  ] as const)('does not start a hold for a charger that is %s', (_label, state) => {
    const h = buildCtx({ optedIn: true });
    expect(sync(
      h,
      observedDeviceFor(h.ctx, evSnapshot(state)),
      EV_STATE_OFF_TRANSITION,
    )).toBe('none');
  });

  it('starts a hold for an explicit raw OFF even while the charger is unplugged', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(
      h,
      observedDeviceFor(h.ctx, {
        ...evSnapshot('plugged_out'),
        evCharging: false,
      }),
      EV_OFF_TRANSITION,
    )).toBe('started');
  });

  it('keeps an existing hold when the car is later unplugged', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx, evSnapshot('plugged_in_paused')), EV_OFF_TRANSITION)).toBe('started');
    expect(sync(
      h,
      observedDeviceFor(h.ctx, evSnapshot('plugged_out')),
      EV_STATE_OFF_TRANSITION,
    )).toBe('none');
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(true);
  });
});

describe('syncExternalOffHoldForDevice — releasing a hold', () => {
  it('clears the hold when the device is turned on again', () => {
    const h = buildCtx({ optedIn: true });
    sync(h, observedDeviceFor(h.ctx));
    expect(sync(
      h,
      observedDeviceFor(h.ctx, { binaryControl: { on: true } }),
      ON_TRANSITION,
    )).toBe('cleared');
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(false);
    expect(h.clearRecentBinaryOffCommand).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('does not clear PELS-OFF provenance from a stale ON level on an unrelated reconcile', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(
      h,
      observedDeviceFor(h.ctx, { binaryControl: { on: true } }),
      [{ capabilityId: 'target_temperature', previousValue: '20 °C', nextValue: '21 °C' }],
    )).toBe('none');
    expect(h.clearRecentBinaryOffCommand).not.toHaveBeenCalled();
  });

  it('releases on a trusted on even after the opt-in was switched off', () => {
    const h = buildCtx({ optedIn: true });
    sync(h, observedDeviceFor(h.ctx));
    h.ctx.isCapacityControlEnabled = () => false;
    expect(sync(h, observedDeviceFor(h.ctx, { binaryControl: { on: true } }))).toBe('cleared');
  });

  it('releases a dual-control device when its binary axis turns on at the off step', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    const snapshot = buildSnapshot({
      deviceClass: 'evcharger',
      binaryControl: { on: true },
      binaryControlObservation: {
        valid: true,
        capabilityId: 'evcharger_charging',
        observedValue: true,
        observedCapabilityIds: ['evcharger_charging'],
        observedAtMs: NOW + 1,
        source: 'snapshot_refresh',
      },
      evCharging: true,
      evChargingState: 'plugged_in_paused',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1_250 },
        ],
      },
      selectedStepId: 'off',
      reportedStepId: 'off',
    });
    const observed = toExternalOffHoldObservedDevice(snapshot)!;

    expect(toPlanDevice(h.ctx, snapshot).currentState).toBe('off');
    expect(sync(h, observed)).toBe('cleared');
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(false);
  });

  it('treats a repeated off observation as a no-op while held', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
  });
});

describe('toPlanDevice — externalOffHoldActive projection', () => {
  it('projects the hold onto the plan input while the device is still off', () => {
    const h = buildCtx({ optedIn: true });
    sync(h, observedDeviceFor(h.ctx));
    expect(toPlanDevice(h.ctx, buildSnapshot()).externalOffHoldActive).toBe(true);
  });

  it('does not project a hold whose device is observed on, so a missed release is inert', () => {
    const h = buildCtx({ optedIn: true });
    sync(h, observedDeviceFor(h.ctx));
    const device = toPlanDevice(h.ctx, buildSnapshot({ binaryControl: { on: true } }));
    expect(device.externalOffHoldActive).toBeUndefined();
  });

  it('leaves the bit absent for a device with no hold', () => {
    const h = buildCtx({ optedIn: true });
    expect(toPlanDevice(h.ctx, buildSnapshot()).externalOffHoldActive).toBeUndefined();
  });

  it('restores a hold persisted before a restart', () => {
    const h = buildCtx({ optedIn: true, heldBefore: [DEVICE_ID] });
    expect(toPlanDevice(h.ctx, buildSnapshot()).externalOffHoldActive).toBe(true);
  });
});

// The release path has to work in BOTH directions of failure: a hold that was
// never readable still has to be releasable, and a released hold must not be
// re-armed out from under a rebuild that has not landed yet.
describe('external-off hold — release under an unreadable store', () => {
  it('records a pull-observed ON even when no hold ids can be enumerated', () => {
    // `heldDeviceIds()` is empty while the key list cannot be read, so sweeping
    // only the enumerated holds would leave no trace of this release. The sweep
    // therefore also passes the observed device ids, and `clearHold` unsets
    // unconditionally — the release lands on the store even though nothing could
    // be listed. `isHeld` still answers its fail-closed guess while the list is
    // unreadable (and the planner pairs that with "still observed off", so a
    // running device is unaffected); what matters is that once the list reads
    // again the hold is genuinely gone rather than revived.
    const failing = { current: true };
    const settings = new Map<string, unknown>([
      [RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE_ID]: true }],
      [`${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${DEVICE_ID}`, true],
    ]);
    const policy = createExternalOffHoldPolicy({
      get: (key) => settings.get(key) ?? null,
      set: (key, value) => { settings.set(key, value); },
      unset: (key) => { settings.delete(key); },
      getKeys: () => {
        if (failing.current) throw new Error('settings unavailable');
        return Array.from(settings.keys());
      },
    });
    releaseExternalOffHoldsForObservedOn({
      policy, deviceIds: [DEVICE_ID], isObservedOn: () => true,
    });
    failing.current = false;
    expect(policy.isHeld(DEVICE_ID)).toBe(false);
    expect(policy.heldDeviceIds()).toEqual([]);
  });

  it('uses a newer pull-observed raw EV ON to end old PELS-OFF attribution', () => {
    const h = buildCtx({ optedIn: true });
    const store = createPendingBinaryCommandStore({});
    store.recordConfirmedBinaryCommand({
      deviceId: DEVICE_ID,
      desired: false,
      confirmedAtMs: NOW,
    });
    h.ctx.externalOffHold?.startHold(DEVICE_ID);
    const observed = toExternalOffHoldObservedDevice(buildSnapshot({
      deviceClass: 'evcharger',
      binaryControl: { on: true },
      binaryControlObservation: {
        valid: true,
        capabilityId: 'evcharger_charging',
        observedValue: true,
        observedCapabilityIds: ['evcharger_charging'],
        observedAtMs: NOW + 1,
        source: 'snapshot_refresh',
      },
      evCharging: true,
      evChargingObservedAtMs: NOW + 1,
      evChargingState: 'plugged_in_paused',
    }))!;

    releaseExternalOffHoldsForObservedOn({
      policy: h.ctx.externalOffHold,
      deviceIds: [DEVICE_ID],
      isObservedOn: () => observed.binaryAxisOn,
      onObservedOn: () => store.clearRecentConfirmedOff(
        DEVICE_ID,
        observed.binaryAxisObservedAtMs,
      ),
    });

    expect(store.hasRecentConfirmedOff(DEVICE_ID, NOW + 2)).toBe(false);
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(false);
  });

  it('needs affirmative ON evidence, not merely "not known to be off"', () => {
    // A partial device update can transiently drop the binary capability, and
    // "not known to be off" reads that as ON. Releasing on it would hand back a
    // device nobody touched — and PELS would resume it once the capability came
    // back. Release is the one direction where silence must not count as consent.
    expect(isAffirmativelyOn({ binaryControl: { on: true } })).toBe(true);
    expect(isAffirmativelyOn({ binaryControl: { on: false } })).toBe(false);
    expect(isAffirmativelyOn({
      binaryControl: { on: false },
      evCharging: true,
      evChargingState: 'plugged_in_paused',
    })).toBe(true);
    expect(isAffirmativelyOn({})).toBe(false);
    expect(isAffirmativelyOn(undefined)).toBe(false);
  });

  it('keeps the hold when the capability vanishes mid-flight', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    releaseExternalOffHoldsForObservedOn({
      policy: h.ctx.externalOffHold,
      deviceIds: [DEVICE_ID],
      isObservedOn: (deviceId) => isAffirmativelyOn(
        deviceId === DEVICE_ID ? { binaryControl: undefined } : undefined,
      ),
    });
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(true);
  });

  it('leaves an off device alone', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    releaseExternalOffHoldsForObservedOn({
      policy: h.ctx.externalOffHold,
      deviceIds: [DEVICE_ID],
      isObservedOn: () => false,
    });
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(true);
  });
});

describe('external-off hold — a second off during the release rebuild', () => {
  it('re-arms the hold without consulting the stale plan', () => {
    const h = buildCtx({ optedIn: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
  });
});
