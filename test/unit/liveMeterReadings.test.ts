// A FAILED live-power read must not be published as a generation observation.
//
// The adapter reports a failed read as `{ state: 'unavailable' }` — a dead REST
// client and a thrown fetch both land there — and a parsed payload as
// `measured`, whose generation half is `measured`, `none`, or `unavailable`
// (a malformed signal, which publishes nothing either). On `homey_energy`
// publishing from a failed read would be harmless (no meter reading, so no
// sample is recorded). On `flow` it is not: net keeps arriving from the Flow
// card regardless, so a fresh-stamped absence would overwrite the companion
// poll's good reading, sail past the 60 s freshness window, and move the
// gross-consumption split.
import { describe, expect, it, vi } from 'vitest';
import { resolveLiveMeterReadings } from '../../lib/device/transport/liveMeterReadings';
import type { LivePowerReport } from '../../lib/device/transport/managerFetch';

const buildGenerationDispatcher = () => {
  const dispatcher = {
    setGenerationW: vi.fn(),
  };
  return {
    setGenerationW: dispatcher.setGenerationW,
    dispatcher,
  };
};

type MeasuredReport = Extract<LivePowerReport, { state: 'measured' }>;

const measuredReport = (overrides: Partial<Omit<MeasuredReport, 'state'>>): LivePowerReport => ({
  state: 'measured',
  byDeviceId: {},
  meterPowerW: { 'meter-main': 1_200 },
  generation: { state: 'none' },
  deviceCount: 0,
  ...overrides,
});

describe('resolveLiveMeterReadings generation publication', () => {
  it('publishes generation from a measured report', () => {
    const { setGenerationW, dispatcher } = buildGenerationDispatcher();
    resolveLiveMeterReadings(setGenerationW, measuredReport({ generation: { state: 'measured', watts: 4_200 } }));
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(4_200, expect.any(Number));
  });

  it('publishes "no generator" from a measured report — it is an observation', () => {
    const { setGenerationW, dispatcher } = buildGenerationDispatcher();
    resolveLiveMeterReadings(setGenerationW, measuredReport({ generation: { state: 'none' } }));
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(null, expect.any(Number));
  });

  it('publishes NOTHING for a malformed generation signal, but still yields the meter readings', () => {
    const { setGenerationW, dispatcher } = buildGenerationDispatcher();
    const readings = resolveLiveMeterReadings(setGenerationW, measuredReport({ generation: { state: 'unavailable' } }));
    expect(dispatcher.setGenerationW).not.toHaveBeenCalled();
    expect(readings).toEqual({ meterPowerW: { 'meter-main': 1_200 } });
  });

  it('publishes NOTHING from a failed read, leaving the held value to age out', () => {
    const { setGenerationW, dispatcher } = buildGenerationDispatcher();
    expect(resolveLiveMeterReadings(setGenerationW, { state: 'unavailable' })).toBeNull();
    expect(dispatcher.setGenerationW).not.toHaveBeenCalled();
  });
});

describe('resolveLiveMeterReadings readings', () => {
  it('carries the meters with the generation read beside them', () => {
    const { setGenerationW } = buildGenerationDispatcher();
    expect(resolveLiveMeterReadings(setGenerationW, measuredReport({ generation: { state: 'measured', watts: 300 } })))
      .toEqual({ meterPowerW: { 'meter-main': 1_200 }, generationW: 300 });
    expect(resolveLiveMeterReadings(setGenerationW, measuredReport({})))
      .toEqual({ meterPowerW: { 'meter-main': 1_200 } });
  });

  it('still publishes generation when no requested meter answered', () => {
    const { setGenerationW, dispatcher } = buildGenerationDispatcher();
    const readings = resolveLiveMeterReadings(setGenerationW, measuredReport({
      meterPowerW: {},
      generation: { state: 'measured', watts: 900 },
    }));
    expect(readings).toEqual({ meterPowerW: {}, generationW: 900 });
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(900, expect.any(Number));
  });
});
