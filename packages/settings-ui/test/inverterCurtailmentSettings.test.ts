import { beforeEach, describe, expect, it, vi } from 'vitest';

const homey = vi.hoisted(() => ({
  callApi: vi.fn(), getApiReadModel: vi.fn(), getSetting: vi.fn(), getSettingFresh: vi.fn(),
  invalidateApiCache: vi.fn(), setSetting: vi.fn(),
}));
vi.mock('../src/ui/homey.ts', () => homey);
import { InverterCurtailmentSettingsController } from '../src/ui/inverterCurtailmentSettings.ts';

const KEY = 'inverter_curtailment_devices';

describe('native inverter settings through existing channels', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    homey.getApiReadModel.mockResolvedValue({ inverterDevices: [{ id: 'pv', name: 'Roof inverter' }] });
    homey.getSetting.mockResolvedValue({ pv: false, other: true });
    homey.setSetting.mockResolvedValue(undefined);
  });

  async function loaded() {
    const controller = new InverterCurtailmentSettingsController(vi.fn());
    controller.ensureLoaded();
    await vi.waitFor(() => expect(controller.props().read).not.toBeNull());
    return controller;
  }

  it('uses ui_devices for controls and Homey.get for the opt-in map', async () => {
    const controller = await loaded();
    expect(homey.getApiReadModel).toHaveBeenCalledWith('/ui_devices');
    expect(homey.getSetting).toHaveBeenCalledWith(KEY);
    expect(controller.props().read?.selected).toEqual({ pv: false, other: true });
    expect(homey.callApi).not.toHaveBeenCalled();
  });

  it('merges only into the fresh complete map, preserving runtime opt-outs and invisible entries', async () => {
    const controller = await loaded();
    homey.getSettingFresh.mockResolvedValue({ other: false, invisible: true });
    controller.props().onEnabledChange('pv', true);
    await vi.waitFor(() => expect(homey.setSetting).toHaveBeenCalledWith(KEY, {
      pv: true, other: false, invisible: true,
    }));
  });

  it.each([null, undefined])('requires a fresh owner-resolved bootstrap for a missing fresh read (%s)', async (missing) => {
    const controller = await loaded();
    homey.getSettingFresh.mockResolvedValue(missing);
    homey.callApi.mockResolvedValue({ settings: { [KEY]: {} } });
    controller.props().onEnabledChange('pv', true);
    await vi.waitFor(() => expect(homey.setSetting).toHaveBeenCalledWith(KEY, { pv: true }));
    expect(homey.callApi).toHaveBeenCalledWith('GET', '/ui_bootstrap');
  });

  it.each([null, { pv: 'yes' }, undefined])('refuses a write when owner confirmation is unavailable or malformed (%s)', async (raw) => {
    const controller = await loaded();
    homey.getSettingFresh.mockResolvedValue(null);
    homey.callApi.mockResolvedValue({ settings: { [KEY]: raw } });
    controller.props().onEnabledChange('pv', true);
    await vi.waitFor(() => expect(controller.props().error).toContain('not saved'));
    expect(homey.setSetting).not.toHaveBeenCalled();
    expect(controller.props().read?.selected).toEqual({ pv: false, other: true });
  });

  it('keeps the last visible read and reports a refused scoped roster', async () => {
    const controller = await loaded();
    homey.getApiReadModel.mockResolvedValue({ inverterDevices: [], homeScope: { state: 'unavailable' } });
    controller.props().onRetry();
    await vi.waitFor(() => expect(controller.props().error).toContain('could not be loaded'));
    expect(controller.props().read?.devices).toEqual([{ id: 'pv', name: 'Roof inverter' }]);
    expect(homey.setSetting).not.toHaveBeenCalled();
  });
});
