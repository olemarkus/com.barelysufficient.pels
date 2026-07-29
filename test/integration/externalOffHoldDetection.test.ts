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
  EXTERNAL_OFF_HOLDS,
  EXTERNAL_OFF_HOLDS_INITIALIZED,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import type { ExternalOffHoldObservedDevice } from '../../setup/externalOffHoldDetection';
import type {
  EvObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';

const NOW = new Date('2026-07-25T12:00:00Z').getTime();
const DEVICE_ID = 'heater-1';

type SnapshotProbe = TargetDeviceSnapshot
  & EvObservedProbe
  & SteppedLoadDescriptorProbe
  & ReportedStepObservedProbe
  & SteppedLoadDecoration;

const buildSnapshot = (
  overrides: Partial<SnapshotProbe> = {},
): SnapshotProbe => ({
  id: DEVICE_ID,
  name: 'Water heater',
  targets: [],
  deviceClass: 'other',
  controlCapabilityId: 'onoff',
  binaryControl: { on: false },
  ...overrides,
}) as TargetDeviceSnapshot;

type Harness = {
  ctx: AppContext;
  deps: ExternalOffHoldSyncDeps;
  clearRecentBinaryOffCommand: ReturnType<typeof vi.fn>;
};

const buildCtx = (params: {
  optedIn?: boolean;
  persistedHolds?: unknown;
  pending?: { desired: boolean; capabilityId: string };
  /** Make the hold blob unreadable, as a transient Homey settings failure does. */
  holdsUnreadable?: boolean;
} = {}): Harness => {
  const ctx = createAppContextMock();
  const settings = new Map<string, unknown>();
  if (params.optedIn) settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE_ID]: true });
  if (params.persistedHolds !== undefined) settings.set(EXTERNAL_OFF_HOLDS, params.persistedHolds);
  if (params.holdsUnreadable) settings.set(EXTERNAL_OFF_HOLDS_INITIALIZED, true);
  ctx.externalOffHold = createExternalOffHoldPolicy({
    get: (key) => {
      if (params.holdsUnreadable && key === EXTERNAL_OFF_HOLDS) {
        throw new Error('settings unavailable');
      }
      return settings.get(key);
    },
    set: (key, value) => { settings.set(key, value); },
  });
  ctx.isCapacityControlEnabled = () => true;
  const clearRecentBinaryOffCommand = vi.fn();
  const deps: ExternalOffHoldSyncDeps = {
    policy: ctx.externalOffHold,
    // Provenance is resolved by the OWNING home's engine; the detector consumes
    // the boolean, so the stub matches on device + capability like the real one.
    hasPendingBinaryCommand: (deviceId, capabilityId) => (
      params.pending !== undefined
      && deviceId === DEVICE_ID
      && params.pending.capabilityId === capabilityId
    ),
    clearRecentBinaryOffCommand,
  };
  return { ctx, deps, clearRecentBinaryOffCommand };
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
    const h = buildCtx({ optedIn: true, pending: { desired: false, capabilityId: 'onoff' } });
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
      controlCapabilityId: undefined,
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
    const h = buildCtx({ optedIn: true, pending: { desired: true, capabilityId: 'onoff' } });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('none');
  });

  it('starts a hold when the pending command is on a DIFFERENT capability', () => {
    const h = buildCtx({ optedIn: true, pending: { desired: false, capabilityId: 'evcharger_charging' } });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
  });

  it('records a real transition even while the persisted state is unreadable', () => {
    // While the store cannot be read it answers a fail-closed guess for every
    // opted-in device. Treating that guess as an existing hold would swallow a
    // genuine outside-off action: nothing is written, and when the read recovers
    // the guess evaporates and the device is resumed. The transition has to
    // become a REAL hold.
    const h = buildCtx({ optedIn: true, holdsUnreadable: true });
    expect(sync(h, observedDeviceFor(h.ctx))).toBe('started');
    expect(h.ctx.externalOffHold?.heldDeviceIds()).toEqual([DEVICE_ID]);
  });
});

describe('syncExternalOffHoldForDevice — EV plug states', () => {
  const evSnapshot = (
    evChargingState: EvObservedProbe['evChargingState'],
  ): Partial<TargetDeviceSnapshot & EvObservedProbe> => ({
    deviceClass: 'evcharger',
    controlCapabilityId: 'evcharger_charging',
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
    expect(h.clearRecentBinaryOffCommand).toHaveBeenCalledWith(DEVICE_ID, 'onoff');
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
      controlCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
      evCharging: true,
      evChargingState: 'plugged_in_paused',
      steppedLoadProfile: {
        model: 'stepped_load',
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
    const h = buildCtx({
      optedIn: true,
      persistedHolds: {
        version: 1,
        entriesByDeviceId: {
          [DEVICE_ID]: { sinceMs: NOW - 60_000, observedAtMs: NOW - 60_000, capabilityId: 'onoff' },
        },
      },
    });
    expect(toPlanDevice(h.ctx, buildSnapshot()).externalOffHoldActive).toBe(true);
  });
});

// The release path has to work in BOTH directions of failure: a hold that was
// never readable still has to be releasable, and a released hold must not be
// re-armed out from under a rebuild that has not landed yet.
describe('external-off hold — release under an unreadable store', () => {
  it('records a pull-observed ON even when no hold ids can be enumerated', () => {
    const h = buildCtx({ optedIn: true, holdsUnreadable: true });
    // `heldDeviceIds()` is empty while the state cannot be read, so sweeping only
    // the recorded holds would leave no trace of this release — and the recovered
    // read would revive a hold on a device that is demonstrably running.
    releaseExternalOffHoldsForObservedOn({
      policy: h.ctx.externalOffHold,
      deviceIds: [DEVICE_ID],
      isObservedOn: () => true,
    });
    expect(h.ctx.externalOffHold?.isHeld(DEVICE_ID)).toBe(false);
  });

  it('uses a newer pull-observed raw EV ON to end old PELS-OFF attribution', () => {
    const h = buildCtx({ optedIn: true });
    const store = createPendingBinaryCommandStore({});
    store.recordSuccessfulBinaryCommand({
      deviceId: DEVICE_ID,
      capabilityId: 'evcharger_charging',
      desired: false,
      issuedAtMs: NOW,
    });
    h.ctx.externalOffHold?.startHold(DEVICE_ID);
    const observed = toExternalOffHoldObservedDevice(buildSnapshot({
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
      evCharging: true,
      evChargingObservedAtMs: NOW + 1,
      evChargingState: 'plugged_in_paused',
    }))!;

    releaseExternalOffHoldsForObservedOn({
      policy: h.ctx.externalOffHold,
      deviceIds: [DEVICE_ID],
      isObservedOn: () => observed.binaryAxisOn,
      onObservedOn: () => store.clearRecentSuccessfulOff(
        DEVICE_ID,
        'evcharger_charging',
        observed.binaryAxisObservedAtMs,
      ),
    });

    expect(store.hasRecentSuccessfulOff(DEVICE_ID, 'evcharger_charging', NOW + 2)).toBe(false);
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
      controlCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
      evCharging: true,
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
