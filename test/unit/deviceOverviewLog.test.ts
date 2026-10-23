import {
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice,
  buildPresentationSignatureForDevice,
  type OverviewDecisionFacts,
  type OverviewLogDevice,
} from '../../lib/plan/deviceOverviewLog';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildOverviewSteppedLoad } from '../../lib/plan/planOverviewSteppedState';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { buildOverviewDeviceCard, overviewReadModelWiring } from '../utils/settingsOverviewFixture';
import { executionStateFixture } from '../utils/deviceStatusFixture';

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

// The debug event's decision facts; these tests assert the presented fields.
const decision: OverviewDecisionFacts = {
  reasonCode: 'keep', plannedState: 'keep', desiredStepId: null, observedStepId: null,
  binaryProgress: 'settled', stepProgress: 'undriven', targetProgress: 'undriven',
};

describe('buildOverviewSignatureForDevice', () => {
  const withStatus = (
    device: OverviewLogDevice, status: Partial<OverviewLogDevice['status']>,
  ): OverviewLogDevice => ({ ...device, status: { ...device.status, ...status } });

  it('ignores measured readings in the fact line so a drifting temperature is not a state change', () => {
    const base = withStatus(overviewLogDevice(), { factText: '47.4 °C · target 22 °C' });
    const drifted = withStatus(base, { factText: '47.3 °C · target 22 °C' });
    expect(buildOverviewSignatureForDevice(drifted)).toBe(buildOverviewSignatureForDevice(base));
  });

  it('records a categorical fact change such as a charger becoming unplugged', () => {
    const base = withStatus(overviewLogDevice(), { factText: 'Charging · 64 % · level 16 A' });
    const unplugged = withStatus(base, { factText: 'Unplugged · Level 16 A' });
    expect(buildOverviewSignatureForDevice(unplugged)).not.toBe(buildOverviewSignatureForDevice(base));
    const batteryDrift = withStatus(base, { factText: 'Charging · 65 % · level 16 A' });
    expect(buildOverviewSignatureForDevice(batteryDrift)).toBe(buildOverviewSignatureForDevice(base));
  });

  it('still records a change of state, reason or kind of power line', () => {
    const base = overviewLogDevice();
    const signature = buildOverviewSignatureForDevice(base);
    expect(buildOverviewSignatureForDevice(withStatus(base, { kind: 'held', label: 'Limited' }))).not.toBe(signature);
    expect(buildOverviewSignatureForDevice(withStatus(base, { reason: { text: 'Waiting to resume' } })))
      .not.toBe(signature);
    expect(buildOverviewSignatureForDevice(withStatus(base, { powerText: '1.4 kW', powerVariant: 'live' })))
      .not.toBe(signature);
  });

  it('ignores a power reading moving within the same kind of power line', () => {
    const base = withStatus(overviewLogDevice(), { powerText: '1.4 kW', powerVariant: 'live' });
    const signature = buildOverviewSignatureForDevice(base);
    expect(buildOverviewSignatureForDevice(withStatus(base, { powerText: '1.5 kW' }))).toBe(signature);
    expect(buildOverviewSignatureForDevice(withStatus(base, { powerText: null }))).not.toBe(signature);
    expect(buildOverviewSignatureForDevice(withStatus(base, {
      powerText: 'Reported 1.4 kW', powerVariant: 'reported' }))).not.toBe(signature);
    expect(buildOverviewSignatureForDevice(withStatus(base, {
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
    expect(buildOverviewSignatureForDevice(moved)).toBe(buildOverviewSignatureForDevice(base));
    const otherCause = withStatus(base, { reason: { text: 'Waiting for cheaper hours' } });
    expect(buildOverviewSignatureForDevice(otherCause)).not.toBe(buildOverviewSignatureForDevice(base));
  });

  it('treats a countdown re-anchored on a later rebuild as the same countdown', () => {
    const countdown = { kind: 'in_text' as const, endsAtMs: 60_000, totalSec: 60,
      prefix: 'Waiting after limiting a device (', suffix: ')' };
    const base = withStatus(overviewLogDevice(), { reason: { text: 'Waiting after limiting a device (60s)', countdown } });
    const reanchored = withStatus(base, { reason: { text: 'Waiting after limiting a device (59s)',
      countdown: { ...countdown, endsAtMs: 60_400 } } });
    expect(buildOverviewSignatureForDevice(reanchored)).toBe(buildOverviewSignatureForDevice(base));
    const otherCause = withStatus(base, { reason: { text: 'Waiting for power to settle (60s)',
      countdown: { ...countdown, prefix: 'Waiting for power to settle (' } } });
    expect(buildOverviewSignatureForDevice(otherCause)).not.toBe(buildOverviewSignatureForDevice(base));
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
      id: 'dev', plannedState: 'shed', currentState: 'off',
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
      id: 'dev', plannedState: 'shed', currentState: 'off',
      reason: { code: 'capacity', reserveHolderName: 'Water heater' },
    }), decision);
    expect(event['cardReasonText']).toBe('Waiting so Water heater can start');
  });

  it.each([
    [
      'cooldown',
      { code: 'cooldown_restore' as const, remainingSec: 18 },
      'Waiting to increase — 18s',
    ],
    [
      'queue',
      { code: 'waiting_for_other_devices' as const },
      'Waiting to increase — other devices are ahead',
    ],
  ])('logs the action-specific line for an active stepped device in the %s', (_label, reason, copy) => {
    const event = buildOverviewEventForDevice(asOverviewLogDevice(steppedPlanDevice({
      id: 'charger',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      selectedStepId: 'medium',
      reason,
    })), decision);

    expect(event['statusMsg']).toBe(copy);
    expect(event['cardReasonText']).toBe(copy);
  });

  // The `not_applicable` + known-rung case that used to be asserted here is gone
  // with the card branch it pinned. The producer cannot emit that combination:
  // a stepped device with a known rung resolves to on/off, and only an unknown
  // rung falls through to `not_applicable`. That contract is pinned directly in
  // `test/unit/observedState.test.ts` (`resolveObservedCurrentState`).

  it.each([
    ['a running device', { plannedState: 'keep' as const, currentState: 'on' }],
    ['an idle device', { plannedState: 'inactive' as const, currentState: 'on' }],
  ])('logs null for %s, which renders no reason line', (_label, state) => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', ...state, reason: { code: 'keep', detail: null },
    }), decision);
    expect(event['cardReasonText']).toBeNull();
  });
});
