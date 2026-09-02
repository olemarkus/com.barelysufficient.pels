// A FAILED live-power read must not be published as a generation observation.
//
// The adapter reports a failed read as `{ state: 'unavailable' }` — a dead REST
// client and a thrown fetch both land there — and a parsed payload as
// `measured`, whose generation half is `measured`, `none`, or `unavailable`
// (a malformed signal, which publishes nothing either). On `homey_energy`
// publishing from a failed read would be harmless (no whole-home reading, so no
// sample is recorded). On `flow` it is not: net keeps arriving from the Flow
// card regardless, so a fresh-stamped absence would overwrite the companion
// poll's good reading, sail past the 60 s freshness window, and move the
// gross-consumption split.
import { describe, expect, it, vi } from 'vitest';
import { updateHomePowerFromReport } from '../../lib/device/transport/resolvedHomeMeterDispatch';
import type { LivePowerReport } from '../../lib/device/transport/managerFetch';
import type { TransportContext } from '../../lib/device/transport/transportContext';

const buildCtx = () => {
  const dispatcher = {
    setGenerationW: vi.fn(),
  };
  return {
    ctx: { observedStateDispatcher: dispatcher } as unknown as TransportContext,
    dispatcher,
  };
};

type MeasuredReport = Extract<LivePowerReport, { state: 'measured' }>;

const measuredReport = (overrides: Partial<Omit<MeasuredReport, 'state'>>): LivePowerReport => ({
  state: 'measured',
  byDeviceId: {},
  home: { state: 'resolved', watts: 1_200, meterDeviceId: 'meter-main' },
  generation: { state: 'none' },
  deviceCount: 0,
  additionalMeterPowerW: {},
  ...overrides,
});

describe('updateHomePowerFromReport generation publication', () => {
  it('publishes generation from a measured report', () => {
    const { ctx, dispatcher } = buildCtx();
    updateHomePowerFromReport(ctx, measuredReport({ generation: { state: 'measured', watts: 4_200 } }));
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(4_200, expect.any(Number));
  });

  it('publishes "no generator" from a measured report — it is an observation', () => {
    const { ctx, dispatcher } = buildCtx();
    updateHomePowerFromReport(ctx, measuredReport({ generation: { state: 'none' } }));
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(null, expect.any(Number));
  });

  it('publishes NOTHING for a malformed generation signal, but still yields the net sample', () => {
    const { ctx, dispatcher } = buildCtx();
    const sample = updateHomePowerFromReport(ctx, measuredReport({ generation: { state: 'unavailable' } }));
    expect(dispatcher.setGenerationW).not.toHaveBeenCalled();
    expect(sample).toEqual({ powerW: 1_200, meterDeviceId: 'meter-main' });
  });

  it('publishes NOTHING from a failed read, leaving the held value to age out', () => {
    const { ctx, dispatcher } = buildCtx();
    expect(updateHomePowerFromReport(ctx, { state: 'unavailable' })).toBeNull();
    expect(dispatcher.setGenerationW).not.toHaveBeenCalled();
  });
});

describe('updateHomePowerFromReport sample', () => {
  it('builds the sample from the resolved reading, identity included', () => {
    const { ctx } = buildCtx();
    expect(updateHomePowerFromReport(ctx, measuredReport({ generation: { state: 'measured', watts: 300 } })))
      .toEqual({ powerW: 1_200, generationW: 300, meterDeviceId: 'meter-main' });
    expect(updateHomePowerFromReport(ctx, measuredReport({})))
      .toEqual({ powerW: 1_200, meterDeviceId: 'meter-main' });
  });

  it('yields no sample when the whole-home reading is unavailable, but still publishes generation', () => {
    const { ctx, dispatcher } = buildCtx();
    const sample = updateHomePowerFromReport(ctx, measuredReport({
      home: { state: 'unavailable' },
      generation: { state: 'measured', watts: 900 },
    }));
    expect(sample).toBeNull();
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(900, expect.any(Number));
  });
});
