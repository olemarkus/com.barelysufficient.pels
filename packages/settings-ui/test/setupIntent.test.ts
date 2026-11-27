import type { SetupGoalChoice, SetupGoalChoices } from '../src/ui/setupGoals.ts';

const { getSettingFresh, setSetting } = vi.hoisted(() => ({
  getSettingFresh: vi.fn<(_key: string) => Promise<unknown>>(),
  setSetting: vi.fn<(_key: string, _value: unknown) => Promise<void>>(),
}));
vi.mock('../src/ui/homey.ts', () => ({ getSettingFresh, setSetting }));

const load = async () => import('../src/ui/setupIntent.ts');

beforeEach(() => {
  vi.resetModules();
  getSettingFresh.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
});

describe('setup intent', () => {
  it('puts the quarter-hour goal first for Belgium and offers every goal everywhere', async () => {
    const { setupIntentOptions } = await load();
    const dutch = setupIntentOptions({ state: 'resolved', country: 'NL' });
    expect(dutch).toEqual(['solar', 'battery', 'quarter-hour', 'general']);
    expect(setupIntentOptions({ state: 'resolved', country: 'BE' }))
      .toEqual(['quarter-hour', 'solar', 'battery', 'general']);
    expect(setupIntentOptions({ state: 'unavailable' })).toEqual(dutch);
  });

  it('writes only the preference, preserves the accepted answer on failure, and reads it on reload', async () => {
    const { loadSetupIntent, readSetupIntent, saveSetupIntent } = await load();
    expect(await loadSetupIntent()).toBe(true);
    expect(readSetupIntent()).toBeNull();
    await saveSetupIntent('solar');
    setSetting.mockRejectedValueOnce(new Error('Offline'));
    await expect(saveSetupIntent('battery')).rejects.toThrow('Offline');
    expect(readSetupIntent()).toBe('solar');
    await saveSetupIntent('general');
    expect(setSetting.mock.calls).toEqual([
      ['setup_intent', 'solar'], ['setup_intent', 'battery'], ['setup_intent', 'general'],
    ]);

    vi.resetModules();
    getSettingFresh.mockResolvedValue('general');
    const reopened = await load();
    await reopened.loadSetupIntent();
    expect(reopened.readSetupIntent()).toBe('general');
  });

  it('keeps an accepted choice when an earlier read arrives later', async () => {
    let finishRead: (value: unknown) => void = () => { throw new Error('No read in flight'); };
    getSettingFresh.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const { loadSetupIntent, readSetupIntent, saveSetupIntent } = await load();
    const initialRead = loadSetupIntent();
    getSettingFresh.mockResolvedValue('battery');
    await saveSetupIntent('battery');
    finishRead('solar');
    await initialRead;
    expect(readSetupIntent()).toBe('battery');
  });

  it('refreshes only this preference when another WebView changes it', async () => {
    const { loadSetupIntent, readSetupIntent, reloadSetupIntentIfChanged } = await load();
    await loadSetupIntent();
    getSettingFresh.mockResolvedValue('quarter-hour');
    reloadSetupIntentIfChanged('managed_devices');
    expect(getSettingFresh).toHaveBeenCalledTimes(1);
    reloadSetupIntentIfChanged('setup_intent');
    await vi.waitFor(() => expect(readSetupIntent()).toBe('quarter-hour'));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('keeps all existing jobs and moves matching device rows first', async () => {
    const { prioritizeSetupGoalChoices } = await load();
    const heatPump: SetupGoalChoice = {
      id: 'heat', name: 'Heat pump', price: { enabled: false },
      smartTask: null, solar: null, battery: null, noGoalReason: null,
    };
    const solarPump: SetupGoalChoice = { ...heatPump, id: 'solar', solar: {
      label: 'Use solar surplus', hint: null, actionLabel: 'Use solar surplus', focus: 'solar', configured: false,
    } };
    const battery: SetupGoalChoice = { ...heatPump, id: 'battery', price: null, battery: { state: 'loading' } };
    const choices: SetupGoalChoices = { state: 'ready', priceSource: null, hasActions: true, devices: [heatPump, battery, solarPump] };
    expect(prioritizeSetupGoalChoices(choices, 'solar')).toEqual({ ...choices, devices: [solarPump, heatPump, battery] });
    expect(prioritizeSetupGoalChoices(choices, 'battery')).toEqual({ ...choices, devices: [battery, heatPump, solarPump] });
    expect(prioritizeSetupGoalChoices(choices, 'quarter-hour')).toBe(choices);
  });
});
