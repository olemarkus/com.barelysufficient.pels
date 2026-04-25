import { registerFlowCards, type FlowCardDeps } from '../flowCards/registerFlowCards';
import type { FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../lib/core/steppedLoadSyntheticCapabilities';

const stateChangedOutcome = (
  overrides: Partial<FlowBackedCapabilityReportOutcome> = {},
): FlowBackedCapabilityReportOutcome => ({
  kind: 'state_changed',
  valueChanged: true,
  freshnessAdvanced: true,
  refreshSnapshot: true,
  rebuildPlan: true,
  ...overrides,
});

const buildDeps = (overrides: Partial<FlowCardDeps> = {}) => {
  const actionListeners: Record<string, (args: unknown) => Promise<unknown>> = {};
  const structuredInfo = vi.fn();
  const structuredWarn = vi.fn();
  const actionAutocompleteListeners: Record<string, Record<string, (query: string, args?: Record<string, unknown>) => Promise<unknown>>> = {};
  const triggerListeners: Record<string, (args: unknown, state?: unknown) => Promise<unknown>> = {};
  const triggerAutocompleteListeners: Record<string, Record<string, (query: string, args?: Record<string, unknown>) => Promise<unknown>>> = {};
  const createCard = (cardId: string, kind: 'action' | 'condition' | 'trigger' = 'action') => ({
    registerRunListener: (listener: (args: unknown, state?: unknown) => Promise<unknown>) => {
      if (kind === 'trigger') {
        triggerListeners[cardId] = (args, state) => listener(args, state);
        return;
      }
      actionListeners[cardId] = (args) => listener(args);
    },
    registerArgumentAutocompleteListener: (arg: string, listener: (query: string, args?: Record<string, unknown>) => Promise<unknown>) => {
      const container = kind === 'trigger' ? triggerAutocompleteListeners : actionAutocompleteListeners;
      container[cardId] = {
        ...(container[cardId] ?? {}),
        [arg]: listener,
      };
    },
    trigger: vi.fn(),
  });
  const deps: FlowCardDeps = {
    homey: {
      flow: {
        getActionCard: (cardId: string) => createCard(cardId, 'action'),
        getConditionCard: (cardId: string) => createCard(cardId, 'condition'),
        getTriggerCard: (cardId: string) => createCard(cardId, 'trigger'),
      },
      settings: { get: vi.fn(), set: vi.fn() },
    },
    structuredLog: { info: vi.fn() },
    resolveModeName: (mode) => mode,
    getAllModes: () => new Set(['Home']),
    getCurrentOperatingMode: () => 'Home',
    handleOperatingModeChange: vi.fn().mockResolvedValue(undefined),
    getCurrentPriceLevel: vi.fn() as never,
    recordPowerSample: vi.fn().mockResolvedValue(undefined),
    getCapacityGuard: vi.fn(),
    getHeadroom: vi.fn(() => null),
    setCapacityLimit: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue([]),
    refreshSnapshot: vi.fn().mockResolvedValue(undefined),
    getHomeyDevicesForFlow: vi.fn().mockResolvedValue([]),
    reportFlowBackedCapability: vi.fn(() => stateChangedOutcome()),
    reportSteppedLoadActualStep: vi.fn(() => 'changed'),
    getDeviceLoadSetting: vi.fn().mockResolvedValue(null),
    setExpectedOverride: vi.fn(() => false),
    storeFlowPriceData: vi.fn(),
    rebuildPlan: vi.fn(),
    evaluateHeadroomForDevice: vi.fn(() => null),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    getCombinedHourlyPrices: vi.fn(() => []),
    getTimeZone: vi.fn(() => 'Europe/Oslo'),
    getNow: vi.fn(() => new Date('2026-03-11T10:00:00Z')),
    getStructuredLogger: vi.fn(() => ({ info: structuredInfo, warn: structuredWarn })),
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    actionListeners,
    actionAutocompleteListeners,
    triggerListeners,
    triggerAutocompleteListeners,
    structuredInfo,
    structuredWarn,
  };
};

describe('registerFlowCards', () => {
  it('normalizes non-Error failures from external price flow cards', async () => {
    const { deps, actionListeners } = buildDeps({
      storeFlowPriceData: vi.fn(() => {
        throw 'boom';
      }),
    });

    registerFlowCards(deps);

    await expect(actionListeners.set_external_prices_today({ prices_json: '{}' })).rejects.toThrow('boom');
    expect(deps.error).toHaveBeenCalledWith(
      'Flow: Failed to store today prices from flow tag.',
      expect.any(Error),
    );
    expect(((deps.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Error).message).toBe('boom');
  });

  it('writes a clean boolean map for budget exemption flow cards without direct rebuild work', async () => {
    const settingsGet = vi.fn((key: string) => {
      if (key === 'budget_exempt_devices') return [true];
      return undefined;
    });
    const settingsSet = vi.fn();
    const { deps, actionListeners } = buildDeps({
      homey: {
        flow: {
          getActionCard: (cardId: string) => ({
            registerRunListener: (listener: (args: unknown, state?: unknown) => Promise<unknown>) => {
              actionListeners[cardId] = (args) => listener(args);
            },
            registerArgumentAutocompleteListener: vi.fn(),
            trigger: vi.fn(),
          }),
          getConditionCard: (_cardId: string) => ({
            registerRunListener: vi.fn(),
            registerArgumentAutocompleteListener: vi.fn(),
            trigger: vi.fn(),
          }),
          getTriggerCard: (_cardId: string) => ({
            registerRunListener: vi.fn(),
            registerArgumentAutocompleteListener: vi.fn(),
            trigger: vi.fn(),
          }),
        },
        settings: { get: settingsGet, set: settingsSet },
      } as FlowCardDeps['homey'],
      getSnapshot: vi.fn().mockResolvedValue([{ id: 'dev-1', name: 'Heater' }]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.add_budget_exemption({ device: 'dev-1' })).resolves.toBe(true);

    expect(settingsSet).toHaveBeenCalledWith('budget_exempt_devices', { 'dev-1': true });
    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.refreshSnapshot).not.toHaveBeenCalled();
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('skips flow-backed card registration when flow-backed cards are unavailable', () => {
    const { deps, actionListeners, triggerListeners } = buildDeps({
      areFlowBackedCardsAvailable: () => false,
    });

    registerFlowCards(deps);

    expect(actionListeners.report_flow_backed_device_onoff).toBeUndefined();
    expect(actionListeners.report_flow_backed_device_evcharger_charging).toBeUndefined();
    expect(triggerListeners.flow_backed_device_turn_on_requested).toBeUndefined();
    expect(triggerListeners.flow_backed_device_refresh_requested).toBeUndefined();
    expect(actionListeners.report_stepped_load_actual_step).toEqual(expect.any(Function));
  });

  it('reports stepped-load actual step and requests a snapshot refresh plus plan rebuild', async () => {
    const { deps, actionListeners, structuredInfo } = buildDeps({
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'max', planningPowerW: 3000 },
            ],
          },
        },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_actual_step({
      device: 'dev-1',
      step: 'max',
    })).resolves.toBe(true);

    expect(deps.reportSteppedLoadActualStep).toHaveBeenCalledWith('dev-1', 'max');
    expect(deps.refreshSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlan).toHaveBeenCalledWith('report_stepped_load_actual_step');
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_received',
      sourceCardId: 'report_stepped_load_actual_step',
      deviceId: 'dev-1',
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      reportedStepId: 'max',
    }));
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_resolved',
      sourceCardId: 'report_stepped_load_actual_step',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      resolvedStepId: 'max',
      outcome: 'accepted',
    }));
  });

  it('accepts a stepped-load actual step report when snapshot lookup fails', async () => {
    const { deps, actionListeners, structuredInfo } = buildDeps({
      getSnapshot: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_actual_step({
      device: 'dev-1',
      step: 'max',
    })).resolves.toBe(true);

    expect(deps.reportSteppedLoadActualStep).toHaveBeenCalledWith('dev-1', 'max');
    expect(deps.refreshSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlan).toHaveBeenCalledWith('report_stepped_load_actual_step');
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_resolved',
      sourceCardId: 'report_stepped_load_actual_step',
      deviceId: 'dev-1',
      deviceName: 'dev-1',
      resolvedStepId: 'max',
      outcome: 'accepted',
    }));
  });

  it('does not log accepted when the post-report snapshot refresh fails', async () => {
    const { deps, actionListeners, structuredInfo, structuredWarn } = buildDeps({
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'max', planningPowerW: 3000 },
            ],
          },
        },
      ]),
      refreshSnapshot: vi.fn().mockRejectedValue(new Error('refresh failed')),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_actual_step({
      device: 'dev-1',
      step: 'max',
    })).rejects.toThrow('refresh failed');

    const acceptedEvents = structuredInfo.mock.calls.filter(([payload]) => (
      payload
      && typeof payload === 'object'
      && (payload as { event?: string; outcome?: string }).event === 'stepped_load_report_resolved'
      && (payload as { outcome?: string }).outcome === 'accepted'
    ));
    expect(acceptedEvents).toHaveLength(0);
    expect(structuredWarn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_rejected',
      sourceCardId: 'report_stepped_load_actual_step',
      deviceId: 'dev-1',
      reportedStepId: 'max',
      reasonCode: 'unexpected_error',
      errorMessage: 'refresh failed',
    }));
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('treats an echoed stepped-load step report as a successful no-op', async () => {
    const { deps, actionListeners } = buildDeps({
      reportSteppedLoadActualStep: vi.fn(() => 'unchanged'),
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'max', planningPowerW: 3000 },
            ],
          },
        },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_actual_step({
      device: 'dev-1',
      step: 'max',
    })).resolves.toBe(true);

    expect(deps.reportSteppedLoadActualStep).toHaveBeenCalledWith('dev-1', 'max');
    expect(deps.refreshSnapshot).not.toHaveBeenCalled();
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('logs one terminal rejection event when the service rejects the reported step', async () => {
    const { deps, actionListeners, structuredInfo, structuredWarn } = buildDeps({
      reportSteppedLoadActualStep: vi.fn(() => 'invalid'),
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'max', planningPowerW: 3000 },
            ],
          },
        },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_actual_step({
      device: 'dev-1',
      step: 'max',
    })).rejects.toThrow('Device is not configured as a stepped load, or the reported step is invalid.');

    const resolvedEvents = structuredInfo.mock.calls.filter(([payload]) => (
      payload && typeof payload === 'object' && (payload as { event?: string }).event === 'stepped_load_report_resolved'
    ));
    expect(resolvedEvents).toHaveLength(0);
    expect(structuredWarn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_rejected',
      sourceCardId: 'report_stepped_load_actual_step',
      deviceId: 'dev-1',
      reportedStepId: 'max',
      reasonCode: 'invalid_step',
      errorMessage: 'Device is not configured as a stepped load, or the reported step is invalid.',
    }));
  });

  it('maps stepped-load power text to a configured step and strips a trailing W', async () => {
    const { deps, actionListeners, structuredInfo } = buildDeps({
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'low', planningPowerW: 1750 },
              { id: 'max', planningPowerW: 3000 },
            ],
          },
        },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_power({
      device: 'dev-1',
      power_w: '1750 W',
    })).resolves.toBe(true);

    expect(deps.reportSteppedLoadActualStep).toHaveBeenCalledWith('dev-1', 'low');
    expect(deps.refreshSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlan).toHaveBeenCalledWith('report_stepped_load_power');
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_received',
      sourceCardId: 'report_stepped_load_power',
      deviceId: 'dev-1',
      rawPowerInput: '1750 W',
    }));
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_resolved',
      sourceCardId: 'report_stepped_load_power',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      resolvedStepId: 'low',
      parsedPowerW: 1750,
      outcome: 'accepted',
    }));
  });

  it('logs an explicit rejection when no configured step matches the reported power', async () => {
    const { deps, actionListeners, structuredInfo, structuredWarn } = buildDeps({
      getSnapshot: vi.fn().mockResolvedValue([
        {
          id: 'dev-1',
          name: 'Tank',
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'low', planningPowerW: 1750 },
            ],
          },
        },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_stepped_load_power({
      device: 'dev-1',
      power_w: '3000 W',
    })).rejects.toThrow('No configured stepped-load step matches 3000 W.');

    expect(deps.reportSteppedLoadActualStep).not.toHaveBeenCalled();
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_received',
      sourceCardId: 'report_stepped_load_power',
      deviceId: 'dev-1',
      rawPowerInput: '3000 W',
    }));
    expect(structuredWarn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_report_rejected',
      sourceCardId: 'report_stepped_load_power',
      deviceId: 'dev-1',
      rawPowerInput: '3000 W',
      reasonCode: 'no_matching_step',
      errorMessage: 'No configured stepped-load step matches 3000 W.',
    }));
  });

  it('does not refresh snapshot or rebuild when a flow-backed report is unchanged', async () => {
    const { deps, actionListeners } = buildDeps({
      reportFlowBackedCapability: vi.fn(() => stateChangedOutcome({
        kind: 'noop',
        valueChanged: false,
        freshnessAdvanced: false,
        refreshSnapshot: false,
        rebuildPlan: false,
      })),
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Relay', class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_flow_backed_device_onoff({
      device: 'dev-1',
      state: 'on',
    })).resolves.toBe(true);

    expect(deps.reportFlowBackedCapability).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      capabilityId: 'onoff',
      value: true,
    });
    expect(deps.refreshSnapshot).not.toHaveBeenCalled();
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
    expect(deps.structuredLog?.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_backed_capability_report_native_overlap',
      sourceCardId: 'report_flow_backed_device_onoff',
      deviceId: 'dev-1',
      deviceName: 'Relay',
      capabilityId: 'onoff',
      value: true,
      reportKind: 'noop',
      valueChanged: false,
      freshnessAdvanced: false,
      nativeCapabilityPresent: true,
    }));
  });

  it('parses EV car connection autocomplete values as boolean flow reports', async () => {
    const { deps, actionListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Wallbox', class: 'evcharger', capabilities: ['evcharger_charging', 'alarm_generic.car_connected'] },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_flow_backed_device_evcharger_car_connected({
      device: 'dev-1',
      state: { id: 'connected', name: 'Connected' },
    })).resolves.toBe(true);

    expect(deps.reportFlowBackedCapability).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      capabilityId: 'alarm_generic.car_connected',
      value: true,
    });
    expect(deps.structuredLog?.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_backed_capability_reported',
      sourceCardId: 'report_flow_backed_device_evcharger_car_connected',
      deviceId: 'dev-1',
      deviceName: 'Wallbox',
      capabilityId: 'alarm_generic.car_connected',
      value: true,
      nativeCapabilityPresent: false,
    }));
  });

  it('parses EV resumable autocomplete values as boolean flow reports', async () => {
    const { deps, actionListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Wallbox', class: 'evcharger', capabilities: ['evcharger_charging'] },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_flow_backed_device_evcharger_resumable({
      device: 'dev-1',
      state: { id: 'yes', name: 'Yes' },
    })).resolves.toBe(true);

    expect(deps.reportFlowBackedCapability).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      capabilityId: 'pels_evcharger_resumable',
      value: true,
    });
    expect(deps.structuredLog?.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_backed_capability_reported',
      sourceCardId: 'report_flow_backed_device_evcharger_resumable',
      deviceId: 'dev-1',
      deviceName: 'Wallbox',
      capabilityId: 'pels_evcharger_resumable',
      value: true,
      nativeCapabilityPresent: false,
    }));
  });

  it('uses raw Homey devices for flow-backed device autocomplete', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-2', name: 'Garage Charger', zoneName: 'Garage', class: 'evcharger', capabilities: ['evcharger_charging'] },
        { id: 'dev-1', name: 'Attic Relay', class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_evcharger_charging.device('garage');
    expect(options).toEqual([{ id: 'dev-2', name: 'Garage Charger' }]);
  });

  it('disambiguates duplicate flow-backed device names with zone labels', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Wallbox', zoneName: 'Garage', class: 'socket', capabilities: ['onoff'] },
        { id: 'dev-2', name: 'Wallbox', zone: { name: 'Driveway' }, class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_onoff.device('wallbox');
    expect(options).toEqual([
      { id: 'dev-2', name: 'Wallbox (Driveway)' },
      { id: 'dev-1', name: 'Wallbox (Garage)' },
    ]);
  });

  it('uses human-friendly EV car connection autocomplete labels', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps();

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_evcharger_car_connected.state('dis');
    expect(options).toEqual([
      { id: 'disconnected', name: 'Disconnected' },
    ]);
  });

  it('uses yes/no EV resumable autocomplete labels', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps();

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_evcharger_resumable.state('n');
    expect(options).toEqual([
      { id: 'no', name: 'No' },
    ]);
  });

  it('limits EV flow-backed device autocomplete to evcharger devices only', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'ev-1', name: 'Wallbox', class: 'evcharger', capabilities: ['evcharger_charging'] },
        { id: 'socket-1', name: 'Wallbox', class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_evcharger_car_connected.device('wallbox');
    expect(options).toEqual([{ id: 'ev-1', name: 'Wallbox' }]);
  });

  it('limits EV resumable autocomplete to evcharger devices only', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'ev-1', name: 'Wallbox', class: 'evcharger', capabilities: ['evcharger_charging'] },
        { id: 'socket-1', name: 'Wallbox', class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_evcharger_resumable.device('wallbox');
    expect(options).toEqual([{ id: 'ev-1', name: 'Wallbox' }]);
  });

  it('limits flow-backed on/off request autocomplete to devices still missing native onoff', async () => {
    const { deps, triggerAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Relay', class: 'socket', capabilities: [] },
        { id: 'dev-2', name: 'Native Relay', class: 'socket', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await triggerAutocompleteListeners.flow_backed_device_turn_on_requested.device('relay');
    expect(options).toEqual([{ id: 'dev-1', name: 'Relay' }]);
  });

  it('limits EV charging request autocomplete to EV chargers still missing native evcharger_charging', async () => {
    const { deps, triggerAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'ev-1', name: 'Wallbox', class: 'evcharger', capabilities: [] },
        { id: 'ev-2', name: 'Native Wallbox', class: 'evcharger', capabilities: ['evcharger_charging'] },
        { id: 'socket-1', name: 'Socket', class: 'socket', capabilities: [] },
      ]),
    });

    registerFlowCards(deps);

    const options = await triggerAutocompleteListeners.flow_backed_device_start_charging_requested.device('wallbox');
    expect(options).toEqual([{ id: 'ev-1', name: 'Wallbox' }]);
  });

  it('matches flow-backed request triggers by device id only', async () => {
    const { deps, triggerListeners } = buildDeps();

    registerFlowCards(deps);

    await expect(triggerListeners.flow_backed_device_turn_on_requested(
      { device: 'dev-1' },
      { deviceId: 'dev-1' },
    )).resolves.toBe(true);
    await expect(triggerListeners.flow_backed_device_turn_off_requested(
      { device: 'dev-1' },
      { deviceId: 'dev-2' },
    )).resolves.toBe(false);
    await expect(triggerListeners.flow_backed_device_start_charging_requested(
      { device: 'ev-1' },
      { deviceId: 'ev-1' },
    )).resolves.toBe(true);
    await expect(triggerListeners.flow_backed_device_stop_charging_requested(
      { device: 'ev-1' },
      { deviceId: 'ev-1' },
    )).resolves.toBe(true);
  });

  it('excludes temperature and unknown-class devices from binary flow-backed autocomplete', async () => {
    const { deps, actionAutocompleteListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Relay', class: 'socket', capabilities: ['onoff'] },
        { id: 'dev-2', name: 'Thermostat', class: 'heater', capabilities: ['target_temperature', 'measure_temperature'] },
        { id: 'dev-3', name: 'Mystery', class: 'light', capabilities: ['onoff'] },
      ]),
    });

    registerFlowCards(deps);

    const options = await actionAutocompleteListeners.report_flow_backed_device_onoff.device('');
    expect(options).toEqual([{ id: 'dev-1', name: 'Relay' }]);
  });

  it('rejects unsupported devices even if a crafted id is passed to a flow-backed action card', async () => {
    const { deps, actionListeners } = buildDeps({
      getHomeyDevicesForFlow: vi.fn().mockResolvedValue([
        { id: 'dev-1', name: 'Thermostat', class: 'heater', capabilities: ['target_temperature', 'measure_temperature'] },
      ]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.report_flow_backed_device_onoff({
      device: 'dev-1',
      state: 'on',
    })).rejects.toThrow('Selected device is not supported for this card.');
    expect(deps.reportFlowBackedCapability).not.toHaveBeenCalled();
  });
});
