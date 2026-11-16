import {
  mainFuseAmpsFromKva,
  mainFuseKva,
  mainFuseKvaSteps,
  matchingMainFuseKvaStep,
} from '../src/ui/mainFuseKva.ts';

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
type Field = HTMLElement & { value: string; selected: boolean };

const load = async (storedUnit: unknown = null) => {
  vi.resetModules();
  document.body.innerHTML = `
    <md-switch id="settings-main-fuse-enabled"></md-switch>
    <div id="settings-main-fuse-fields"></div>
    <div id="settings-main-fuse-supply"></div>
    <div id="settings-main-fuse-unit-segmented" role="radiogroup"></div>
    <div id="settings-main-fuse-unit">
      <md-select-option value="amps"><div slot="headline">Amps</div></md-select-option>
      <md-select-option value="kva"><div slot="headline">kVA</div></md-select-option>
    </div>
    <span id="settings-main-fuse-amps-label"></span>
    <input id="settings-main-fuse-amps">
    <div id="settings-main-fuse-kva"></div>
    <small id="settings-main-fuse-hint"></small>
    <div id="settings-main-fuse-phase-source">
      <div id="settings-main-fuse-phase-meter-field" hidden></div>
      <div id="settings-main-fuse-phase-capabilities-field" hidden></div>
    </div>`;
  const setSetting = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/ui/homey.ts', async (original) => ({
    ...(await original<object>()),
    getSetting: vi.fn((key: string) => Promise.resolve(key === 'main_fuse_entry_unit' ? storedUnit : null)),
    getApiReadModel: vi.fn().mockResolvedValue({ phaseLoad: { state: 'none', meterCapabilityIds: [] } }),
    callApi: vi.fn().mockResolvedValue([]),
    setSetting,
  }));
  const controls = await import('../src/ui/mainFuseControls.ts');
  const facts = await import('../src/ui/setupPathFacts.ts');
  const autoSave = vi.fn().mockResolvedValue(undefined);
  controls.bindMainFuseControls(autoSave);
  await flush();
  const get = (id: string) => document.querySelector<Field>(id)!;
  const unit = get('#settings-main-fuse-unit');
  const switchUnit = (value: 'amps' | 'kva') => {
    unit.value = value;
    unit.dispatchEvent(new Event('change'));
  };
  return {
    autoSave, setSetting, controls, facts, switchUnit,
    supply: get('#settings-main-fuse-supply'),
    amps: get('#settings-main-fuse-amps'),
    kva: get('#settings-main-fuse-kva'),
    hint: get('#settings-main-fuse-hint'),
  };
};

const fuseWrites = (setSetting: ReturnType<typeof vi.fn>) => (
  setSetting.mock.calls.filter(([key]) => key !== 'main_fuse_entry_unit')
);

describe('subscribed power conversion', () => {
  it('splits a three-phase subscription evenly over the phases', () => {
    expect(mainFuseAmpsFromKva(18, 'three_phase_neutral')).toBeCloseTo(26.087, 3);
    expect(mainFuseAmpsFromKva(9, 'one_phase')).toBeCloseTo(39.13, 2);
  });

  it('round-trips every offered step on both supplies', () => {
    for (const supply of ['one_phase', 'three_phase_neutral', 'three_phase_no_neutral'] as const) {
      for (const kva of mainFuseKvaSteps(supply)) {
        const fuse = { kind: 'on', supply, amps: mainFuseAmpsFromKva(kva, supply) } as const;
        expect(matchingMainFuseKvaStep(fuse)).toBe(kva);
        expect(mainFuseKva(fuse)).toBeCloseTo(kva, 9);
      }
    }
  });

  it('offers only steps that make a valid fuse, and no step for a fuse entered in amps', () => {
    expect(mainFuseKvaSteps('three_phase_neutral')).not.toContain(3);
    expect(mainFuseKvaSteps('one_phase')).toContain(3);
    expect(matchingMainFuseKvaStep({ kind: 'on', supply: 'three_phase_neutral', amps: 25 })).toBeNull();
  });
});

describe('switching how the main fuse is entered', () => {
  it('keeps a fuse entered in amps exactly as stored when switched to kVA', async () => {
    const { autoSave, setSetting, controls, switchUnit, kva, hint } = await load('amps');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps: 25 }, 25);
    switchUnit('kva');
    expect(kva.value).toBe('');
    expect(hint.textContent).toContain('Your fuse, 3x25 A, is about 17.3 kVA.');
    expect(controls.readMainFuseForm()).toEqual({ kind: 'on', supply: 'three_phase_neutral', amps: 25 });
    expect(autoSave).not.toHaveBeenCalled();
    expect(setSetting).toHaveBeenCalledWith('main_fuse_entry_unit', 'kva');
    expect(fuseWrites(setSetting)).toEqual([]);
  });

  it('shows the subscription a fuse was saved from', async () => {
    const { controls, switchUnit, kva } = await load('amps');
    const amps = mainFuseAmpsFromKva(18, 'three_phase_neutral');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps }, amps);
    switchUnit('kva');
    expect(kva.value).toBe('18');
  });

  it('saves a picked subscription as amps per phase', async () => {
    const { autoSave, controls, kva } = await load('kva');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps: 25 }, 25);
    kva.value = '12';
    kva.dispatchEvent(new Event('change'));
    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(controls.readMainFuseForm()).toEqual({
      kind: 'on', supply: 'three_phase_neutral', amps: mainFuseAmpsFromKva(12, 'three_phase_neutral'),
    });
  });

  it('shows a converted size rounded but reads back the exact stored amps', async () => {
    const { controls, switchUnit, amps } = await load('kva');
    const exact = mainFuseAmpsFromKva(18, 'three_phase_neutral');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps: exact }, exact);
    switchUnit('amps');
    expect(amps.value).toBe('26.1');
    expect(controls.readMainFuseForm()).toEqual({ kind: 'on', supply: 'three_phase_neutral', amps: exact });
  });

  it('does not save a supply change before a subscription is picked', async () => {
    const { autoSave, controls, supply } = await load('kva');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps: 25 }, 25);
    supply.value = 'one_phase';
    supply.dispatchEvent(new Event('change'));
    expect(autoSave).not.toHaveBeenCalled();
    expect(() => controls.readMainFuseForm()).toThrow('Pick your subscribed power');
  });

  it('keeps the subscription when the supply changes after one is picked', async () => {
    const { autoSave, controls, supply, kva } = await load('kva');
    const amps = mainFuseAmpsFromKva(12, 'three_phase_neutral');
    controls.syncMainFuseControls({ kind: 'on', supply: 'three_phase_neutral', amps }, amps);
    supply.value = 'one_phase';
    supply.dispatchEvent(new Event('change'));
    expect(kva.value).toBe('12');
    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(controls.readMainFuseForm()).toEqual({ kind: 'on', supply: 'one_phase', amps: mainFuseAmpsFromKva(12, 'one_phase') });
  });

  it('turns the fuse back on in kVA with its kept size', async () => {
    const { autoSave, controls, kva, supply } = await load('kva');
    supply.value = 'three_phase_neutral';
    controls.syncMainFuseControls({ kind: 'off' }, 25);
    const enabled = document.querySelector<Field>('#settings-main-fuse-enabled')!;
    enabled.selected = true;
    enabled.dispatchEvent(new Event('change'));
    expect(kva.value).toBe('');
    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(controls.readMainFuseForm()).toEqual({ kind: 'on', supply: 'three_phase_neutral', amps: 25 });
  });

  it('keeps a unit picked before the stored one is read', async () => {
    vi.resetModules();
    let resolveRead: (value: unknown) => void = () => {};
    document.body.innerHTML = `
      <div id="settings-main-fuse-supply"></div>
      <div id="settings-main-fuse-unit"></div>
      <input id="settings-main-fuse-amps">
      <div id="settings-main-fuse-kva"></div>`;
    vi.doMock('../src/ui/homey.ts', async (original) => ({
      ...(await original<object>()),
      getSetting: vi.fn((key: string) => (key === 'main_fuse_entry_unit'
        ? new Promise((resolve) => { resolveRead = resolve; })
        : Promise.resolve(null))),
      getApiReadModel: vi.fn().mockResolvedValue({ phaseLoad: { state: 'none', meterCapabilityIds: [] } }),
      callApi: vi.fn().mockResolvedValue([]),
      setSetting: vi.fn().mockResolvedValue(undefined),
    }));
    const controls = await import('../src/ui/mainFuseControls.ts');
    controls.bindMainFuseControls(vi.fn().mockResolvedValue(undefined));
    const unit = document.querySelector<Field>('#settings-main-fuse-unit')!;
    unit.value = 'kva';
    unit.dispatchEvent(new Event('change'));
    resolveRead('amps');
    await flush();
    expect(document.querySelector<Field>('#settings-main-fuse-kva')!.hidden).toBe(false);
  });

  it('enters French fuses in kVA until the owner chooses, and nowhere else', async () => {
    const { controls, facts, kva, amps } = await load(null);
    controls.syncMainFuseControls({ kind: 'off' }, null);
    expect(kva.hidden).toBe(true);
    facts.publishSetupMarket({ state: 'resolved', country: 'FR' });
    expect(kva.hidden).toBe(false);
    expect(amps.hidden).toBe(true);
  });

  it('keeps a chosen unit when the market lands', async () => {
    const { controls, facts, kva } = await load('amps');
    controls.syncMainFuseControls({ kind: 'off' }, null);
    facts.publishSetupMarket({ state: 'resolved', country: 'FR' });
    expect(kva.hidden).toBe(true);
  });
});
