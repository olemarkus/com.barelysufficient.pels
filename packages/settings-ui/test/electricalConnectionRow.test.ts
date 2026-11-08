const flushPromises = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

type TestSelect = HTMLElement & { value: string };

const buildDom = () => {
  document.body.innerHTML = `
    <div id="device-detail-electrical-connection-row" hidden>
      <md-filled-select id="device-detail-electrical-connection">
        <md-select-option value="automatic"></md-select-option>
        <md-select-option value="L1"></md-select-option>
        <md-select-option value="self_balancing"></md-select-option>
      </md-filled-select>
    </div>`;
};

const load = async () => {
  vi.resetModules();
  buildDom();
  const setSetting = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/ui/homey.ts', () => ({
    getSetting: vi.fn(), getSettingFresh: vi.fn().mockResolvedValue(null), setSetting,
  }));
  const { state } = await import('../src/ui/state.ts');
  const module = await import('../src/ui/deviceDetail/electricalConnection.ts');
  return { state, setSetting, ...module };
};

const heater = { id: 'd1', name: 'Heater', deviceClass: 'heater' } as never;
const row = () => document.querySelector<HTMLElement>('#device-detail-electrical-connection-row')!;
const select = () => document.querySelector<TestSelect>('#device-detail-electrical-connection')!;

describe('Electrical connection row', () => {
  it('shows only with a three-phase supply with neutral', async () => {
    const { state, syncElectricalConnectionRow } = await load();
    state.mainFuseSupply = 'three_phase_no_neutral';
    syncElectricalConnectionRow('d1', heater);
    expect(row().hidden).toBe(true);
    state.mainFuseSupply = 'three_phase_neutral';
    state.devicePhaseConnectionMap = { d1: 'L1' };
    syncElectricalConnectionRow('d1', heater);
    expect(row().hidden).toBe(false);
    expect(select().value).toBe('L1');
  });

  it('offers self balancing only for an EV charger', async () => {
    const { state, syncElectricalConnectionRow } = await load();
    state.mainFuseSupply = 'three_phase_neutral';
    syncElectricalConnectionRow('d1', heater);
    const option = document.querySelector('md-select-option[value="self_balancing"]')!;
    expect(option.hasAttribute('hidden')).toBe(true);
    syncElectricalConnectionRow('d1', { id: 'd1', name: 'EV', deviceClass: 'evcharger', isEvCharger: true } as never);
    expect(option.hasAttribute('hidden')).toBe(false);
  });

  it('deletes the entry when Automatic is chosen', async () => {
    const { state, setSetting, initElectricalConnectionHandler } = await load();
    state.devicePhaseConnectionMap = { d1: 'L1', d2: 'L2' };
    initElectricalConnectionHandler({ getCurrentDetailDeviceId: () => 'd1', refreshOpenDeviceDetail: vi.fn() });
    select().value = 'automatic';
    select().dispatchEvent(new Event('change'));
    await flushPromises();
    await flushPromises();
    expect(setSetting).toHaveBeenCalledWith('device_phase_connections', { d2: 'L2' });
  });
});
