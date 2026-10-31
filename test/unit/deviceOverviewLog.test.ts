import {
  buildDeviceLogEntry,
  buildLoggedReasonShape,
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice as buildSignatureWithReason,
  buildPresentationSignatureForDevice,
  type OverviewDecisionFacts,
  type OverviewLogDevice,
} from '../../lib/plan/deviceOverviewLog';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildOverviewSteppedLoad } from '../../lib/plan/planOverviewSteppedState';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { buildOverviewDeviceCard, overviewReadModelWiring } from '../utils/settingsOverviewFixture';
import { executionStateFixture } from '../utils/deviceStatusFixture';
import { DeviceOverviewTransitions } from '../../lib/plan/planOverviewEmit';
import type { DeviceOverviewLogRecorder } from '../../lib/diagnostics/deviceActivityRecorder';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUi/plan';
import { partialDouble } from '../helpers/partialDouble';
import { insufficientHeadroomFixtureReason } from '../utils/deviceReasonTestUtils';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';

// The log seam receives the same resolved presentation as the UI.
// Keep the decision anchor and display clock fixed; these tests do not advance time.
const asOverviewLogDevice = (device: DevicePlanDevice): OverviewLogDevice => buildOverviewDeviceCard(device, {
  ...overviewReadModelWiring(),
  getDeviceExecutionState: () => executionStateFixture(device), dryRun: false, nowMs: 0,
  getThermalDirection: () => 'heating' as const,
  getObservedTemperature: () => ({ kind: 'absent' }),
  getObservedStateOfCharge: () => ({ kind: 'absent' }),
  getHomeBatteryCard: () => ({ kind: 'none' } as const),
  getObservedEvChargingState: () => ({ kind: 'absent' }),
});

const overviewLogDevice = (
  overrides: Parameters<typeof buildPlanDevice>[0] = {},
): OverviewLogDevice => asOverviewLogDevice(buildPlanDevice(overrides));

// The signature with the device's own reason, as the log compares it outside a countdown wait.
const signatureOf = (
  device: OverviewLogDevice, reasonCode: OverviewDecisionFacts['reasonCode'] = 'keep', stepCommandUnanswered = false,
): string => buildSignatureWithReason(device, buildLoggedReasonShape(device.status, {
  reasonCode, stepCommandUnanswered, steppedStepUpHold: false,
}), { steppedStepUpHold: false });

// The debug event's decision facts; these tests assert the presented fields.
const decision: OverviewDecisionFacts = {
  reasonCode: 'keep', plannedState: 'keep', steppedStepUpHold: false, desiredStepId: null, observedStepId: null,
  binaryProgress: 'settled', stepProgress: 'undriven', targetProgress: 'undriven', stepCommandUnanswered: false,
};

describe('buildOverviewSignatureForDevice', () => {
  const withStatus = (
    device: OverviewLogDevice, status: Partial<OverviewLogDevice['status']>,
  ): OverviewLogDevice => ({ ...device, status: { ...device.status, ...status } });

  it('ignores measured readings in the fact line so a drifting temperature is not a state change', () => {
    const base = withStatus(overviewLogDevice(), { factText: '47.4 °C · target 22 °C' });
    const drifted = withStatus(base, { factText: '47.3 °C · target 22 °C' });
    expect(signatureOf(drifted)).toBe(signatureOf(base));
  });

  it('records a categorical fact change such as a charger becoming unplugged', () => {
    const base = withStatus(overviewLogDevice(), { factText: 'Charging · 64 % · level 16 A' });
    const unplugged = withStatus(base, { factText: 'Unplugged · Level 16 A' });
    expect(signatureOf(unplugged)).not.toBe(signatureOf(base));
    const batteryDrift = withStatus(base, { factText: 'Charging · 65 % · level 16 A' });
    expect(signatureOf(batteryDrift)).toBe(signatureOf(base));
  });

  it('still records a change of state, reason or kind of power line', () => {
    const base = overviewLogDevice();
    const signature = signatureOf(base);
    expect(signatureOf(withStatus(base, { kind: 'held', label: 'Limited' }))).not.toBe(signature);
    expect(signatureOf(withStatus(base, { reason: { text: 'Waiting to resume' } })))
      .not.toBe(signature);
    expect(signatureOf(withStatus(base, { powerText: '1.4 kW', powerVariant: 'live' })))
      .not.toBe(signature);
  });

  it('ignores a power reading moving within the same kind of power line', () => {
    const base = withStatus(overviewLogDevice(), { powerText: '1.4 kW', powerVariant: 'live' });
    const signature = signatureOf(base);
    expect(signatureOf(withStatus(base, { powerText: '1.5 kW' }))).toBe(signature);
    expect(signatureOf(withStatus(base, { powerText: null }))).not.toBe(signature);
    expect(signatureOf(withStatus(base, {
      powerText: 'Reported 1.4 kW', powerVariant: 'reported' }))).not.toBe(signature);
    expect(signatureOf(withStatus(base, {
      powerText: '≈ 1.4 kW when active', powerVariant: 'expected' }))).not.toBe(signature);
    // The open card still receives every reading.
    expect(buildPresentationSignatureForDevice(withStatus(base, { powerText: '1.5 kW' })))
      .not.toBe(buildPresentationSignatureForDevice(base));
  });

  it('ignores a shortfall that tracks the pace inside the same reason sentence', () => {
    // The shortfall is recomputed against the pace every cycle; logging each
    // 0.1 kW step would flood the ring the way 3.9.0's comparable reason never did.
    const base = withStatus(overviewLogDevice(), { kind: 'held', label: 'Limited · Off',
      reason: { text: 'Waiting to resume — 0.8 kW more needed' } });
    const moved = withStatus(base, { reason: { text: 'Waiting to resume — 0.9 kW more needed' } });
    expect(signatureOf(moved)).toBe(signatureOf(base));
    const otherCause = withStatus(base, { reason: { text: 'Waiting for cheaper hours' } });
    expect(signatureOf(otherCause)).not.toBe(signatureOf(base));
  });

  it('ignores a hold length reworded as it passes an hour', () => {
    // Prod 2026-10-26: "Held 1 h 59 min" → "Held 2 h" → "Held 2 h 1 min", a row each.
    const held = (text: string) => withStatus(overviewLogDevice(), { kind: 'held', label: 'Limited · Off',
      reason: { text } });
    const before = signatureOf(held('Held 1 h 59 min — 1.0 kW more needed'));
    expect(signatureOf(held('Held 2 h — 1.0 kW more needed'))).toBe(before);
    expect(signatureOf(held('Held 2 h 1 min — 1.1 kW more needed'))).toBe(before);
    expect(signatureOf(held('Held 45 min — 1.1 kW more needed'))).toBe(before);
  });

  it('treats a countdown re-anchored on a later rebuild as the same countdown', () => {
    const countdown = { kind: 'in_text' as const, endsAtMs: 60_000, totalSec: 60,
      prefix: 'Waiting after limiting a device (', suffix: ')' };
    const base = withStatus(overviewLogDevice(), { reason: { text: 'Waiting after limiting a device (60s)', countdown } });
    const reanchored = withStatus(base, { reason: { text: 'Waiting after limiting a device (59s)',
      countdown: { ...countdown, endsAtMs: 60_400 } } });
    expect(signatureOf(reanchored)).toBe(signatureOf(base));
    const otherCause = withStatus(base, { reason: { text: 'Waiting for power to settle (60s)',
      countdown: { ...countdown, prefix: 'Waiting for power to settle (' } } });
    expect(signatureOf(otherCause)).not.toBe(signatureOf(base));
  });
});

describe('what the activity log keeps of a device PELS leaves on, and of a countdown wait', () => {
  const withStatus = (
    device: OverviewLogDevice, status: Partial<OverviewLogDevice['status']>,
  ): OverviewLogDevice => ({ ...device, status: { ...device.status, ...status } });
  const cooldown = {
    text: 'Waiting after limiting a device (60s)',
    countdown: { kind: 'in_text' as const, endsAtMs: 60_000, totalSec: 60,
      prefix: 'Waiting after limiting a device (', suffix: ')' },
  };

  it('still records a device left on gaining or losing a reason', () => {
    const resting = withStatus(overviewLogDevice(), { kind: 'idle', tone: 'idle', label: 'Idle' });
    expect(signatureOf(withStatus(resting, { reason: { text: 'Raised while power is cheap' } })))
      .not.toBe(signatureOf(resting));
    expect(signatureOf(withStatus(resting, { kind: 'held', tone: 'held', label: 'Limited' })))
      .not.toBe(signatureOf(resting));
  });

  it('records no row for a running device waiting to step up', () => {
    // Prod 2026-10-26: a water heater running at Low gained and lost "Waiting to
    // increase — other devices are ahead" every minute or two.
    const running = withStatus(overviewLogDevice(), { kind: 'active', tone: 'active', label: 'Running' });
    const waiting = withStatus(running, { reason: { text: 'Waiting to increase — other devices are ahead' } });
    expect(signatureOf(waiting, 'waiting_for_other_devices')).toBe(signatureOf(running));
    // The same wait on a held device is a reason, kept as the wait for power.
    const held = withStatus(waiting, { kind: 'held', tone: 'held', label: 'Limited · Low' });
    expect(signatureOf(held, 'waiting_for_other_devices'))
      .toBe(signatureOf(withStatus(held, { reason: { text: 'Waiting to increase — 1.6 kW more needed' } }), 'capacity'));
    expect(signatureOf(held, 'waiting_for_other_devices'))
      .not.toBe(signatureOf(withStatus(held, { reason: { text: 'Waiting for cheaper hours' } }), 'deferred_objective_avoid'));
    // A step command the device never answered replaces the wait on the card, and is a row of its own.
    const unanswered = withStatus(held, {
      reason: { text: 'Level change not confirmed — check the Flow that reports the level back' } });
    expect(signatureOf(unanswered, 'capacity', true)).not.toBe(signatureOf(held, 'waiting_for_other_devices'));
    expect(signatureOf(withStatus(unanswered, { kind: 'active', tone: 'active', label: 'Running' }), 'capacity', true))
      .not.toBe(signatureOf(running));
  });

  it('stores a countdown wait without its countdown', () => {
    expect(buildDeviceLogEntry(withStatus(overviewLogDevice(), { reason: cooldown }), 0).statusMsg)
      .toBe('Waiting after limiting a device');
    expect(buildDeviceLogEntry(withStatus(overviewLogDevice(), { reason: {
      text: 'Waiting to resume — 270s',
      countdown: { kind: 'in_text', endsAtMs: 270_000, totalSec: 270, prefix: 'Waiting to resume — ', suffix: '' },
    } }), 0).statusMsg).toBe('Waiting to resume');
    expect(buildDeviceLogEntry(withStatus(overviewLogDevice(), { reason: {
      text: 'Would be waiting to resume — 270s (simulation)',
      countdown: { kind: 'in_text', endsAtMs: 270_000, totalSec: 270,
        prefix: 'Would be waiting to resume — ', suffix: ' (simulation)' },
    } }), 0).statusMsg).toBe('Would be waiting to resume (simulation)');
  });

  it('records no row when a held device passes through the pause after another device is limited', () => {
    const recorded: string[] = [];
    const recorder = partialDouble<DeviceOverviewLogRecorder>({
      record: (_device, entry) => { recorded.push(entry.statusMsg); }, flush: () => undefined,
    });
    const held = withStatus(overviewLogDevice({ id: 'adrian' }), {
      kind: 'held', tone: 'held', label: 'Limited · Off', reason: { text: 'Waiting to resume — 4.1 kW more needed' } });
    const transitions = new DeviceOverviewTransitions();
    const capture = (device: OverviewLogDevice) => transitions.capture(
      partialDouble<SettingsUiPlanSnapshot>({ devices: [device] }), recorder, () => decision);
    capture(held);
    expect(capture(withStatus(held, { reason: cooldown }))).toBe(true);
    capture(withStatus(held, { reason: { text: 'Waiting to resume — 0.4 kW more needed' } }));
    expect(recorded).toEqual(['Waiting to resume — 4.1 kW more needed']);
    capture(withStatus(held, { reason: { text: 'Waiting to resume — other devices are ahead' } }));
    expect(recorded).toHaveLength(2);
  });

  it('records the reason coming back after a row written during a countdown wait', () => {
    const recorded: string[] = [];
    const recorder = partialDouble<DeviceOverviewLogRecorder>({
      record: (_device, entry) => { recorded.push(`${entry.stateMsg} | ${entry.statusMsg}`); }, flush: () => undefined,
    });
    const shortfall = { text: 'Waiting to resume — 4.1 kW more needed' };
    const off = withStatus(overviewLogDevice({ id: 'adrian' }), {
      kind: 'held', tone: 'held', label: 'Limited · Off', reason: shortfall });
    const transitions = new DeviceOverviewTransitions();
    const capture = (device: OverviewLogDevice) => transitions.capture(
      partialDouble<SettingsUiPlanSnapshot>({ devices: [device] }), recorder, () => decision);
    capture(off);
    capture(withStatus(off, { label: 'Limited · On', reason: cooldown }));
    capture(withStatus(off, { label: 'Limited · On', reason: cooldown }));
    capture(withStatus(off, { label: 'Limited · On', reason: shortfall }));
    expect(recorded).toEqual([
      'Limited · Off | Waiting to resume — 4.1 kW more needed',
      'Limited · On | Waiting after limiting a device',
      'Limited · On | Waiting to resume — 4.1 kW more needed',
    ]);
  });
});

describe('what the activity log keeps of a stepped device waiting to step up', () => {
  // A water heater PELS stepped from Max to Low, then kept there for lack of room.
  const heater = (overrides: Parameters<typeof steppedPlanDevice>[0]) => steppedPlanDevice({
    id: 'heater', currentState: 'on', currentDrawKw: 1.3, plannedState: 'keep',
    selectedStepId: 'low', reportedStepId: 'low', desiredStepId: 'low', lastDesiredStepId: 'low',
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
    ...overrides,
  });
  const atMax = heater({ currentDrawKw: 3, selectedStepId: 'max', reportedStepId: 'max', desiredStepId: 'max',
    lastDesiredStepId: 'max' });
  const cut = heater({ plannedState: 'shed', reason: { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 50 } });
  const restoreCooldown = heater({ reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 55 } });

  const record = (cycles: DevicePlanDevice[]): string[] => {
    const recorded: string[] = [];
    const recorder = partialDouble<DeviceOverviewLogRecorder>({
      record: (_device, entry) => { recorded.push(`${entry.stateMsg} | ${entry.statusMsg}`); }, flush: () => undefined,
    });
    const transitions = new DeviceOverviewTransitions();
    for (const device of cycles) {
      transitions.capture(partialDouble<SettingsUiPlanSnapshot>({ devices: [asOverviewLogDevice(device)] }), recorder,
        () => ({ ...decision, reasonCode: device.reason.code, steppedStepUpHold: device.steppedStepUpHold === true }));
    }
    return recorded;
  };

  it('logs the wait as the running device it interrupts, with no row while it lasts', () => {
    const waiting = (reason: DevicePlanDevice['reason']) => heater({ reason, steppedStepUpHold: true });
    const held = record([
      atMax, cut,
      waiting({ code: PLAN_REASON_CODES.keep, detail: null }),
      restoreCooldown,
      waiting(insufficientHeadroomFixtureReason({ needKw: 0.7, availableKw: 0.2 })),
      restoreCooldown,
      waiting({ code: PLAN_REASON_CODES.keep, detail: null }),
    ]);
    // The same cycles before the stamp, when the device read `Running` with no line.
    const running = record([atMax, cut, heater({}), restoreCooldown, heater({}), restoreCooldown, heater({})]);

    expect(held).toHaveLength(running.length);
    expect(held).toHaveLength(3);
    expect(held[2]).toBe(`Limited · ${formatStepDisplayLabel('low')} | Waiting to increase`);
  });
});

describe('buildOverviewSteppedLoad', () => {
  // The producer's own ladder is the discriminant, so a STORED-profile stepped
  // device is stepped here without any producer setting to consult. That is the
  // whole point of retiring `controlModel`: both carriers of the overview shape
  // used to reconstruct it, and the read model's reconstruction consulted a
  // raw-snapshot map that cannot see a stored ladder — so the same device came
  // out stepped on the log seam and binary on the card.
  it('marks a stored-profile stepped device as stepped', () => {
    const device = steppedPlanDevice({ id: 'heater' });
    const steppedLoad = buildOverviewSteppedLoad(device, executionStateFixture(device));
    expect(steppedLoad).toBeDefined();
    expect(steppedLoad?.profile.steps.length).toBeGreaterThan(0);
  });

  it('leaves a non-stepped device with no cluster at all', () => {
    const thermostat = buildPlanDevice({ id: 'thermo', deviceType: 'temperature', currentTarget: 21, currentTemperature: 20 });
    const binary = buildPlanDevice({ id: 'x' });
    expect(buildOverviewSteppedLoad(thermostat, executionStateFixture(thermostat))).toBeUndefined();
    expect(buildOverviewSteppedLoad(binary, executionStateFixture(binary))).toBeUndefined();
  });
});

// `cardReasonText` is the resolved reason line delivered to the card.
describe('buildOverviewEventForDevice — cardReasonText', () => {
  it('logs the card line for a held device', () => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', plannedState: 'shed', currentState: 'off' as const,
      reason: { code: 'daily_budget', shortfallKw: 0.9 },
    }), decision);
    expect(event['cardReasonText']).toBe('Waiting to resume — 0.9 kW more needed');
  });

  // Card/log parity for the reservation hold: support reads the same sentence
  // the owner saw, which is the whole point of this field
  // (`feedback_ui_text_shared_with_logs`). The reason code stays `capacity`, so
  // this also pins that the holder's NAME — not a changed code — is what carries
  // the line.
  it('logs the reservation holder for a reserve-blocked device', () => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', plannedState: 'shed', currentState: 'off' as const,
      reason: { code: 'capacity', reserveHolderName: 'Water heater' },
    }), decision);
    expect(event['cardReasonText']).toBe('Waiting so Water heater can start');
  });

  it.each([
    [
      'cooldown',
      { code: 'cooldown_restore' as const, remainingSec: 18 },
      'Waiting to increase — 18s',
      // The activity row keeps no countdown; the card's line does.
      'Waiting to increase',
    ],
    [
      'queue',
      { code: 'waiting_for_other_devices' as const },
      'Waiting to increase — other devices are ahead',
      'Waiting to increase — other devices are ahead',
    ],
  ])('logs the action-specific line for an active stepped device in the %s', (_label, reason, copy, stored) => {
    const event = buildOverviewEventForDevice(asOverviewLogDevice(steppedPlanDevice({
      id: 'charger',
      currentState: 'on' as const,
      plannedState: 'keep',
      reportedStepId: 'low',
      selectedStepId: 'medium',
      reason,
    })), decision);

    expect(event['statusMsg']).toBe(stored);
    expect(event['cardReasonText']).toBe(copy);
  });

  // The `not_applicable` + known-rung case that used to be asserted here is gone
  // with the card branch it pinned. The producer cannot emit that combination:
  // a stepped device with a known rung resolves to on/off, and only an unknown
  // rung falls through to `not_applicable`. That contract is pinned directly in
  // `test/unit/observedState.test.ts` (`resolveObservedCurrentState`).

  it.each([
    ['a running device', { plannedState: 'keep' as const, currentState: 'on' as const }],
    ['an idle device', { plannedState: 'inactive' as const, currentState: 'on' as const }],
  ])('logs null for %s, which renders no reason line', (_label, state) => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', ...state, reason: { code: 'keep', detail: null },
    }), decision);
    expect(event['cardReasonText']).toBeNull();
  });
});
