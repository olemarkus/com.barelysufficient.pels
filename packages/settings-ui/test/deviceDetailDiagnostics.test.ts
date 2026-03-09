import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { createHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock';

const flushPromises = () => new Promise<void>((resolve) => {
  setTimeout(() => resolve(), 0);
});

const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="device-detail-overlay" hidden></div>
    <div id="device-detail-panel"></div>
    <div id="device-detail-title"></div>
    <button id="device-detail-close"></button>
    <input id="device-detail-managed" type="checkbox">
    <input id="device-detail-controllable" type="checkbox">
    <input id="device-detail-price-opt" type="checkbox">
    <div id="device-detail-modes"></div>
    <div id="device-detail-delta-section"></div>
    <input id="device-detail-cheap-delta">
    <input id="device-detail-expensive-delta">
    <select id="device-detail-overshoot">
      <option value="turn_off">Turn off</option>
      <option value="set_temperature">Set to temperature</option>
    </select>
    <div id="device-detail-overshoot-temp-row"></div>
    <input id="device-detail-overshoot-temp">
    <details id="device-detail-diagnostics-disclosure">
      <summary>Advanced diagnostics</summary>
      <div id="device-detail-diagnostics-status"></div>
      <div id="device-detail-diagnostics-cards"></div>
    </details>
  `;
};

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Hall Heater',
  targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
  deviceType: 'temperature',
  powerCapable: true,
  currentOn: true,
  capabilities: ['target_temperature', 'onoff'],
  ...overrides,
});

describe('device detail diagnostics', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('renders lazy-loaded diagnostics in the device detail panel', async () => {
    buildDom();
    const diagnosticsPayload = {
      generatedAt: Date.now(),
      windowDays: 21,
      diagnosticsByDeviceId: {
        'heater-1': {
          currentPenaltyLevel: 2,
          windows: {
            '1d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
            '7d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
            '21d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 3,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
          },
        },
      },
    };
    jest.doMock('../src/ui/devices', () => ({
      renderDevices: jest.fn(),
    }));
    jest.doMock('../src/ui/modes', () => ({
      renderPriorities: jest.fn(),
    }));
    jest.doMock('../src/ui/priceOptimization', () => ({
      renderPriceOptimization: jest.fn(),
      savePriceOptimizationSettings: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/ui/toast', () => ({
      showToastError: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/ui/logging', () => ({
      logSettingsError: jest.fn().mockResolvedValue(undefined),
    }));

    let initDeviceDetailHandlers!: typeof import('../src/ui/deviceDetail').initDeviceDetailHandlers;
    let openDeviceDetail!: typeof import('../src/ui/deviceDetail').openDeviceDetail;
    let state!: typeof import('../src/ui/state').state;
    let homey!: MockHomeyClient;

    jest.isolateModules(() => {
      const homeyModule = require('../src/ui/homey') as typeof import('../src/ui/homey');
      homey = createHomeyMock({
        uiState: {
          deviceDiagnostics: diagnosticsPayload,
        },
      });
      homeyModule.setHomeyClient(homey);
      ({ initDeviceDetailHandlers } = require('../src/ui/deviceDetail') as typeof import('../src/ui/deviceDetail'));
      ({ openDeviceDetail } = require('../src/ui/deviceDetail') as typeof import('../src/ui/deviceDetail'));
      ({ state } = require('../src/ui/state') as typeof import('../src/ui/state'));
    });

    state.latestDevices = [buildDevice()];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 22 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';
    initDeviceDetailHandlers();

    openDeviceDetail('heater-1');
    await flushPromises();

    expect(homey.api.mock.calls.some(
      (call) => call[0] === 'GET' && call[1] === '/ui_device_diagnostics',
    )).toBe(false);

    const diagnosticsDisclosure = document.getElementById('device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));
    await flushPromises();

    expect(homey.api.mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['GET', '/ui_device_diagnostics']),
    ]));
    expect(document.getElementById('device-detail-diagnostics-status')?.textContent).toContain('Current penalty level: L2');
    expect(document.getElementById('device-detail-diagnostics-cards')?.children).toHaveLength(3);
    expect(document.getElementById('device-detail-diagnostics-cards')?.textContent).toContain('Failed activations');
    expect(document.getElementById('device-detail-diagnostics-cards')?.textContent).toContain('Penalty history');
  });

  it('shows an empty diagnostics state when the device has no recorded diagnostics yet', async () => {
    buildDom();
    const diagnosticsPayload = {
      generatedAt: Date.now(),
      windowDays: 21,
      diagnosticsByDeviceId: {},
    };
    jest.doMock('../src/ui/devices', () => ({
      renderDevices: jest.fn(),
    }));
    jest.doMock('../src/ui/modes', () => ({
      renderPriorities: jest.fn(),
    }));
    jest.doMock('../src/ui/priceOptimization', () => ({
      renderPriceOptimization: jest.fn(),
      savePriceOptimizationSettings: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/ui/toast', () => ({
      showToastError: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/ui/logging', () => ({
      logSettingsError: jest.fn().mockResolvedValue(undefined),
    }));

    let initDeviceDetailHandlers!: typeof import('../src/ui/deviceDetail').initDeviceDetailHandlers;
    let openDeviceDetail!: typeof import('../src/ui/deviceDetail').openDeviceDetail;
    let state!: typeof import('../src/ui/state').state;
    let homey!: MockHomeyClient;

    jest.isolateModules(() => {
      const homeyModule = require('../src/ui/homey') as typeof import('../src/ui/homey');
      homey = createHomeyMock({
        uiState: {
          deviceDiagnostics: diagnosticsPayload,
        },
      });
      homeyModule.setHomeyClient(homey);
      ({ initDeviceDetailHandlers } = require('../src/ui/deviceDetail') as typeof import('../src/ui/deviceDetail'));
      ({ openDeviceDetail } = require('../src/ui/deviceDetail') as typeof import('../src/ui/deviceDetail'));
      ({ state } = require('../src/ui/state') as typeof import('../src/ui/state'));
    });

    state.latestDevices = [buildDevice()];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 22 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';
    initDeviceDetailHandlers();

    openDeviceDetail('heater-1');
    await flushPromises();

    expect(homey.api.mock.calls.some(
      (call) => call[0] === 'GET' && call[1] === '/ui_device_diagnostics',
    )).toBe(false);

    const diagnosticsDisclosure = document.getElementById('device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));
    await flushPromises();

    expect(homey.api.mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['GET', '/ui_device_diagnostics']),
    ]));
    expect(document.getElementById('device-detail-diagnostics-status')?.textContent).toBe('No diagnostics recorded yet.');
    expect(document.getElementById('device-detail-diagnostics-cards')?.children).toHaveLength(0);
  });
});
