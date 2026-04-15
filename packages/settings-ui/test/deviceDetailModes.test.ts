import { createHomeyMock } from './helpers/homeyApiMock';
import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const setupDom = () => {
  document.body.innerHTML = `
    <div id="device-detail-modes"></div>
  `;
};

const buildDevice = (): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Hall Heater',
  deviceType: 'temperature',
  currentOn: true,
  targets: [{ id: 'target_temperature', value: 20, unit: '°C', step: 0.5 }],
});

describe('device detail target writes', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid temperature edits into one mode_device_targets write', async () => {
    const renderPriorities = vi.fn();
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities,
    }));
    const homey = createHomeyMock({
      settings: {
        operating_mode: 'Home',
        capacity_priorities: { Home: { 'heater-1': 1 } },
        mode_device_targets: { Home: { 'heater-1': 20 }, Away: { 'heater-1': 18 } },
      },
    });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey);

    const { state } = await import('../src/ui/state.ts');
    state.activeMode = 'Home';
    state.editingMode = 'Home';
    state.latestDevices = [buildDevice()];
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 20 }, Away: { 'heater-1': 18 } };

    const { renderDeviceDetailModes } = await import('../src/ui/deviceDetailModes.ts');
    renderDeviceDetailModes(state.latestDevices[0]);

    const homeInput = document.querySelector('#device-detail-modes .detail-mode-temp[data-mode="Home"]') as HTMLInputElement | null;
    const awayInput = document.querySelector('#device-detail-modes .detail-mode-temp[data-mode="Away"]') as HTMLInputElement | null;
    expect(homeInput).not.toBeNull();
    expect(awayInput).not.toBeNull();

    homeInput!.value = '21';
    homeInput!.dispatchEvent(new Event('change', { bubbles: true }));
    awayInput!.value = '19';
    awayInput!.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(299);
    expect(homey.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(homey.set).toHaveBeenCalledTimes(1);
    expect(homey.set).toHaveBeenCalledWith(
      'mode_device_targets',
      { Home: { 'heater-1': 21 }, Away: { 'heater-1': 19 } },
      expect.any(Function),
    );
    expect(renderPriorities).toHaveBeenCalledWith(state.latestDevices);
  });
});
