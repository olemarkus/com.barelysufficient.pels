// A FAILED live-power read must not be published as a generation observation.
//
// `buildEmptyLivePowerReport()` is what both a dead REST client and a thrown
// fetch return, and its `generationW: null` is shape-identical to a successful
// report from a home with no generator. On `homey_energy` the conflation is
// harmless — the same report nulls `homePowerW`, so no sample is recorded. On
// `flow` it is not: net keeps arriving from the Flow card regardless, so a
// fresh-stamped null would overwrite the companion poll's good reading, sail
// past the 60 s freshness window, and move the gross-consumption split.
import { describe, expect, it, vi } from 'vitest';
import { updateHomePowerFromReport } from '../../lib/device/transport/resolvedHomeMeterDispatch';
import { buildEmptyLivePowerReport, type LivePowerReport } from '../../lib/device/transport/managerFetch';
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

const resolvedReport = (overrides: Partial<LivePowerReport>): LivePowerReport => ({
  ...buildEmptyLivePowerReport(),
  reportAvailable: true,
  homePowerW: 1_200,
  ...overrides,
});

describe('updateHomePowerFromReport generation publication', () => {
  it('publishes generation from a successful report', () => {
    const { ctx, dispatcher } = buildCtx();
    updateHomePowerFromReport(ctx, resolvedReport({ generationW: 4_200 }), { state: 'resolved', meterDeviceId: 'meter-main' });
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(4_200, expect.any(Number));
  });

  it('publishes a null generation from a successful report — "no generator" is an observation', () => {
    const { ctx, dispatcher } = buildCtx();
    updateHomePowerFromReport(ctx, resolvedReport({ generationW: null }), { state: 'resolved', meterDeviceId: 'meter-main' });
    expect(dispatcher.setGenerationW).toHaveBeenCalledWith(null, expect.any(Number));
  });

  it('publishes NOTHING from a failed read, leaving the held value to age out', () => {
    const { ctx, dispatcher } = buildCtx();
    updateHomePowerFromReport(ctx, buildEmptyLivePowerReport(), { state: 'resolved', meterDeviceId: 'meter-main' });
    expect(dispatcher.setGenerationW).not.toHaveBeenCalled();
  });
});
