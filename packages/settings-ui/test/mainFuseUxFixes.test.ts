import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
type Field = HTMLElement & { value: string; selected: boolean };

const load = async (power: unknown = { phaseLoad: { state: 'none', meterCapabilityIds: [] } }) => {
  vi.resetModules();
  document.body.innerHTML = `
    <md-switch id="settings-main-fuse-enabled"></md-switch>
    <div id="settings-main-fuse-fields"></div>
    <div id="settings-main-fuse-supply"></div>
    <input id="settings-main-fuse-amps">
    <small id="settings-main-fuse-hint"></small>
    <div id="settings-main-fuse-phase-source">
      <div id="settings-main-fuse-phase-meter-field" hidden></div>
      <div id="settings-main-fuse-phase-capabilities-field" hidden></div>
    </div>`;
  vi.doMock('../src/ui/homey.ts', async (original) => ({
    ...(await original<object>()),
    getSetting: vi.fn().mockResolvedValue(null),
    getApiReadModel: vi.fn().mockResolvedValue(power),
    callApi: vi.fn().mockResolvedValue([]),
    setSetting: vi.fn(),
  }));
  const controls = await import('../src/ui/mainFuseControls.ts');
  const autoSave = vi.fn().mockResolvedValue(undefined);
  controls.bindMainFuseControls(autoSave);
  const get = (id: string) => document.querySelector<Field>(id)!;
  const enabled = get('#settings-main-fuse-enabled');
  const supply = get('#settings-main-fuse-supply');
  const amps = get('#settings-main-fuse-amps');
  enabled.selected = true;
  supply.value = 'three_phase_neutral';
  return { autoSave, enabled, supply, amps, controls, hint: get('#settings-main-fuse-hint') };
};

describe('main fuse controls', () => {
  it('saves on the switch, the supply and the size', async () => {
    const { autoSave, enabled, supply, amps } = await load();
    amps.value = '25';
    enabled.dispatchEvent(new Event('change'));
    supply.dispatchEvent(new Event('change'));
    amps.dispatchEvent(new Event('change'));
    expect(autoSave).toHaveBeenCalledTimes(3);
  });

  it('shows the range and does not save an invalid size', async () => {
    const { autoSave, amps, hint } = await load();
    amps.value = '999';
    amps.dispatchEvent(new Event('change'));
    expect(autoSave).not.toHaveBeenCalled();
    expect(amps.hasAttribute('error')).toBe(true);
    expect(amps.getAttribute('error-text')).toContain('6 to 250 A');
    expect(hint.hidden).toBe(true);
  });

  it('states the per-phase level with the total', async () => {
    const { amps, hint, controls } = await load();
    amps.value = '25';
    controls.refreshMainFuseControls();
    expect(hint.textContent).toBe('PELS starts reducing loads near 5.5 kW per phase (16.4 kW in total).');
    await flush();
    expect(document.getElementById('settings-main-fuse-phase-source')?.hidden).toBe(true);
  });

  it('shows the picker when the fuse is turned on and uses readable labels', async () => {
    const { amps, controls } = await load({
      phaseLoad: { state: 'none', meterCapabilityIds: ['measure_power.l1'] },
    });
    amps.value = '25';
    controls.refreshMainFuseControls();
    await flush();
    expect(document.getElementById('settings-main-fuse-phase-capabilities-field')?.hidden).toBe(false);
    const { formatPhaseCapabilityLabel } = await import('../src/ui/mainFusePhaseSource.ts');
    expect(formatPhaseCapabilityLabel('measure_power.l1')).toBe('Power L1');
    expect(formatPhaseCapabilityLabel('measure_current.phase_2')).toBe('Current phase 2');
  });
});

describe('main fuse form sync', () => {
  it('states the power-only target from a read taken with the fuse off', async () => {
    const { amps, hint, controls } = await load({
      phaseLoad: { state: 'none', meterCapabilityIds: [], phasesRecognised: true, powerOnly: true },
    });
    amps.value = '25';
    controls.refreshMainFuseControls();
    await flush();
    expect(hint.textContent).toContain('near 5.2 kW per phase');
  });

  it('shows the stored size while the fuse is off', async () => {
    const { amps, controls } = await load();
    controls.syncMainFuseControls({ kind: 'off' }, 25);
    expect(amps.value).toBe('25');
  });
});

describe('hero for a phase hold', () => {
  it('names the phase', async () => {
    const { buildDecisionSentence } = await import('../src/ui/planHeroSummary.ts');
    expect(buildDecisionSentence({
      managedDeviceCount: 1, limitedCount: 1, resumingCount: 0, dryRun: false, projectedOverHardCap: false,
      projectedOverBudget: false, gridImportHigh: false, safePaceKw: 16.4, capacityPeriodMinutes: 60,
      jobs: { state: 'uncounted' }, capacityControlOffCount: 0, sheddableManagedRunningCount: 0, heldForPhase: 'L1',
    }).text).toBe('Holding back 1 device so L1 stays under your main fuse.');
  });

  it('carries the phase on the device status', () => {
    const { status } = uiDeviceFixture({
      id: 'h', name: 'H', plannedState: 'shed', currentState: 'off', reason: { code: 'phase_limit', phase: 'L1' },
    } as never);
    expect(status.heldForPhase).toBe('L1');
  });
});
