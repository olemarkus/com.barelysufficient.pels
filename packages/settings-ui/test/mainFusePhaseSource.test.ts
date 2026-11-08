import { classifyPhaseLoad } from '../src/ui/phaseLoadRead.ts';
import { resolveSetupSteps } from '../src/ui/setupPathModel.ts';

describe('capability choice', () => {
  it('requires three of one kind', async () => {
    const { resolveCapabilityChoice } = await import('../src/ui/mainFusePhaseSource.ts');
    expect(resolveCapabilityChoice(['', '', ''])).toEqual({ kind: 'none' });
    expect(resolveCapabilityChoice(['measure_power.a', '', ''])).toEqual({ kind: 'mixed' });
    expect(resolveCapabilityChoice(['measure_power.a', 'measure_current.b', 'measure_power.c'])).toEqual({ kind: 'mixed' });
    expect(resolveCapabilityChoice(['measure_current.a', 'measure_current.b', 'measure_current.c'])).toMatchObject({
      kind: 'choice', value: { facet: 'current', L1: 'measure_current.a' },
    });
  });

  it('keeps the capability list beside working phases, so an owner choice can be changed', () => {
    const phases = [{ phase: 'L1', amps: 1 }, { phase: 'L2', amps: 2 }, { phase: 'L3', amps: 3 }];
    expect(classifyPhaseLoad({ state: 'phases', fuseAmps: 25, phases, meterCapabilityIds: ['measure_power.a'] }))
      .toMatchObject({ state: 'phases', meterCapabilityIds: ['measure_power.a'] });
  });

  it('keeps the capability list on a read with no phases', () => {
    expect(classifyPhaseLoad({ state: 'none', meterCapabilityIds: ['measure_power.a', 2] })).toEqual({
      state: 'none', meterCapabilityIds: ['measure_power.a'],
    });
  });
});

describe('phase peaks card', () => {
  it('lists newest first and hides when empty', async () => {
    document.body.innerHTML = '<section id="usage-phase-peaks" hidden><ul id="usage-phase-peaks-list"></ul></section>';
    const { renderPhasePeaks } = await import('../src/ui/phasePeaksCard.ts');
    renderPhasePeaks([
      { phase: 'L1', direction: 'import', startedAtMs: 1_000, durationS: 180, peakKw: 6.2, devices: ['Heater'] },
      { phase: 'L2', direction: 'export', startedAtMs: 2_000, durationS: 30, peakKw: 5.9, devices: [] },
    ], 'UTC');
    const items = [...document.querySelectorAll('#usage-phase-peaks-list li')].map((el) => el.textContent);
    expect(items[0]).toContain('L2 export 5.9 kW for 30 s');
    expect(items[1]).toContain('L1 6.2 kW for 3 min · Heater');
    expect(document.getElementById('usage-phase-peaks')?.hidden).toBe(false);
    renderPhasePeaks([], 'UTC');
    expect(document.getElementById('usage-phase-peaks')?.hidden).toBe(true);
  });
});

describe('setup Limits step by market', () => {
  const facts = (market: unknown) => ({
    actionableDeviceCount: 1, limitableDeviceCount: 1, market,
    hardCap: { state: 'unset', runningLimitKw: 5, periodMinutes: 60 },
    power: { state: 'received' }, prices: { state: 'used', complete: true, summary: 'x' },
  }) as never;

  const limitsStep = (market: unknown) => resolveSetupSteps(facts(market)).steps.find((step) => step.id === 'hardCap')!;

  it('offers Main fuse in the Netherlands', () => {
    const step = limitsStep({ state: 'resolved', country: 'NL' });
    expect(step.detail).toContain('main fuse');
    expect(step.target).toEqual({ panel: 'limits', anchor: '#settings-main-fuse-enabled' });
  });

  it('still offers it on a fresh Dutch install with both limits off', () => {
    const step = resolveSetupSteps({
      ...facts({ state: 'resolved', country: 'NL' }) as object, hardCap: { state: 'disabled' },
    } as never).steps.find((entry) => entry.id === 'hardCap')!;
    expect(step.detail).toContain('main fuse');
  });

  it('leaves other markets as they were', () => {
    const step = limitsStep({ state: 'resolved', country: 'NO' });
    expect(step.detail).not.toContain('main fuse');
    expect(step.target).toEqual({ panel: 'limits' });
  });
});
