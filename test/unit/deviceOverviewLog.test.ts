import {
  DeviceOverviewLogRecorder,
  DEVICE_OVERVIEW_LOG_MAX_DEVICES,
  DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE,
  buildOverviewEventForDevice,
} from '../../lib/plan/deviceOverviewLog';
import { buildOverviewSteppedLoad } from '../../lib/plan/planOverviewSteppedState';
import type { SettingsUiDeviceLogEntry } from '../../packages/contracts/src/settingsUiApi';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

// The log seam takes an `OverviewLogDevice` — a plan device plus the display
// fields the plan does not own. `planOverviewEmit` builds `steppedLoad` per
// device before calling in; these tests are about the reason line, so a
// non-stepped device (no cluster) stands in.
const overviewLogDevice = (
  overrides: Parameters<typeof buildPlanDevice>[0] = {},
): ReturnType<typeof buildPlanDevice> => buildPlanDevice(overrides);

const entry = (atMs: number, overrides: Partial<SettingsUiDeviceLogEntry> = {}): SettingsUiDeviceLogEntry => ({
  atMs,
  powerMsg: 'on → off',
  stateMsg: 'Limited',
  usageMsg: 'Measured: 0.00 kW',
  statusMsg: 'Limiting to stay within budget',
  stateKind: 'held',
  stateTone: 'held',
  ...overrides,
});

describe('DeviceOverviewLogRecorder', () => {
  it('stores entries most-recent-first per device', () => {
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100, { stateMsg: 'Running' }));
    recorder.record('dev-1', entry(200, { stateMsg: 'Limited' }));

    const { entriesByDeviceId } = recorder.getUiPayload();
    expect(entriesByDeviceId['dev-1'].map((e) => e.stateMsg)).toEqual(['Limited', 'Running']);
  });

  it('caps retained entries per device, dropping the oldest', () => {
    const recorder = new DeviceOverviewLogRecorder();
    const total = DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE + 5;
    for (let i = 0; i < total; i += 1) {
      recorder.record('dev-1', entry(i, { statusMsg: `s${i}` }));
    }
    const entries = recorder.getUiPayload().entriesByDeviceId['dev-1'];
    expect(entries).toHaveLength(DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE);
    // Newest first; the oldest 5 are gone.
    expect(entries[0].statusMsg).toBe(`s${total - 1}`);
    expect(entries.at(-1)?.statusMsg).toBe(`s${total - DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE}`);
  });

  it('retains history for devices that transiently leave the plan (no eager prune)', () => {
    // Memory is bounded solely by the LRU device cap, so a device dropping out
    // of a single plan pass (e.g. a transient SDK read blip) must keep its
    // history rather than have it wiped.
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100));
    recorder.record('dev-2', entry(100));

    // dev-2 no longer appears in subsequent passes; only dev-1 keeps recording.
    recorder.record('dev-1', entry(200));

    const { entriesByDeviceId } = recorder.getUiPayload();
    expect(Object.keys(entriesByDeviceId).sort()).toEqual(['dev-1', 'dev-2']);
    expect(entriesByDeviceId['dev-2']).toHaveLength(1);
  });

  it('evicts the least-recently-active device past the device cap', () => {
    const recorder = new DeviceOverviewLogRecorder();
    // Fill to the cap; device "old" has the oldest newest-entry timestamp.
    recorder.record('old', entry(1));
    for (let i = 1; i < DEVICE_OVERVIEW_LOG_MAX_DEVICES; i += 1) {
      recorder.record(`dev-${i}`, entry(1000 + i));
    }
    // One past the cap pushes out "old".
    recorder.record('fresh', entry(9999));

    const ids = Object.keys(recorder.getUiPayload().entriesByDeviceId);
    expect(ids).toHaveLength(DEVICE_OVERVIEW_LOG_MAX_DEVICES);
    expect(ids).not.toContain('old');
    expect(ids).toContain('fresh');
  });

  it('returns defensive copies that do not mutate the buffer', () => {
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100));
    const first = recorder.getUiPayload().entriesByDeviceId['dev-1'];
    first.push(entry(200));
    expect(recorder.getUiPayload().entriesByDeviceId['dev-1']).toHaveLength(1);
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
    const steppedLoad = buildOverviewSteppedLoad(steppedPlanDevice({ id: 'heater' }));
    expect(steppedLoad).toBeDefined();
    expect(steppedLoad?.profile.steps.length).toBeGreaterThan(0);
  });

  it('leaves a non-stepped device with no cluster at all', () => {
    expect(buildOverviewSteppedLoad(buildPlanDevice({ id: 'thermo', deviceType: 'temperature', currentTarget: 21, currentTemperature: 20 })))
      .toBeUndefined();
    expect(buildOverviewSteppedLoad(buildPlanDevice({ id: 'x' }))).toBeUndefined();
  });
});

// `cardReasonText` logs the line the CARD rendered, so support can reconstruct
// what the owner saw now that the card and `reasonText` differ by design. The
// resolver behind it is a HELD ladder: called unconditionally it returns its
// terminal "Waiting to resume" fallback for a running device, which would log a
// line no card ever showed — the exact opposite of the field's purpose.
describe('buildOverviewEventForDevice — cardReasonText', () => {
  const overview = {
    powerMsg: 'off', stateMsg: 'Limited', usageMsg: 'Measured: 0.00 kW', statusMsg: 'x',
  };

  it('logs the card line for a held device', () => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', plannedState: 'shed', currentState: 'off',
      reason: { code: 'daily_budget', shortfallKw: 0.9 },
    }), overview);
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
    }), overview);
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
    const event = buildOverviewEventForDevice(steppedPlanDevice({
      id: 'charger',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      selectedStepId: 'medium',
      reason,
    }), overview);

    expect(event['reasonText']).toBe(copy);
    expect(event['cardReasonText']).toBe(copy);
  });

  // The `not_applicable` + known-rung case that used to be asserted here is gone
  // with the card branch it pinned. The producer cannot emit that combination:
  // a stepped device with a known rung resolves to on/off, and only an unknown
  // rung falls through to `not_applicable`. That contract is pinned directly in
  // `test/unit/observedStateResolution.test.ts`.

  it.each([
    ['a running device', { plannedState: 'keep' as const, currentState: 'on' }],
    ['an idle device', { plannedState: 'inactive' as const, currentState: 'on' }],
  ])('logs null for %s, which renders no reason line', (_label, state) => {
    const event = buildOverviewEventForDevice(overviewLogDevice({
      id: 'dev', ...state, reason: { code: 'keep', detail: null },
    }), overview);
    expect(event['cardReasonText']).toBeNull();
  });
});
