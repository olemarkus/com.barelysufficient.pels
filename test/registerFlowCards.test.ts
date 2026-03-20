import { registerFlowCards, type FlowCardDeps } from '../flowCards/registerFlowCards';

const buildDeps = (overrides: Partial<FlowCardDeps> = {}) => {
  const actionListeners: Record<string, (args: unknown) => Promise<unknown>> = {};
  const createCard = (cardId: string) => ({
    registerRunListener: (listener: (args: unknown, state?: unknown) => Promise<unknown>) => {
      actionListeners[cardId] = (args) => listener(args);
    },
    registerArgumentAutocompleteListener: jest.fn(),
    trigger: jest.fn(),
  });
  const deps: FlowCardDeps = {
    homey: {
      flow: {
        getActionCard: (cardId: string) => createCard(cardId),
        getConditionCard: (_cardId: string) => createCard('condition'),
        getTriggerCard: (_cardId: string) => createCard('trigger'),
      },
      settings: { get: jest.fn(), set: jest.fn() },
    },
    resolveModeName: (mode) => mode,
    getAllModes: () => new Set(['Home']),
    getCurrentOperatingMode: () => 'Home',
    handleOperatingModeChange: jest.fn().mockResolvedValue(undefined),
    getCurrentPriceLevel: jest.fn() as never,
    recordPowerSample: jest.fn().mockResolvedValue(undefined),
    getCapacityGuard: jest.fn(),
    getHeadroom: jest.fn(() => null),
    setCapacityLimit: jest.fn(),
    getSnapshot: jest.fn().mockResolvedValue([]),
    refreshSnapshot: jest.fn().mockResolvedValue(undefined),
    reportSteppedLoadActualStep: jest.fn(() => 'changed'),
    getDeviceLoadSetting: jest.fn().mockResolvedValue(null),
    setExpectedOverride: jest.fn(() => false),
    storeFlowPriceData: jest.fn(),
    rebuildPlan: jest.fn(),
    evaluateHeadroomForDevice: jest.fn(() => null),
    loadDailyBudgetSettings: jest.fn(),
    updateDailyBudgetState: jest.fn(),
    getCombinedHourlyPrices: jest.fn(() => []),
    getTimeZone: jest.fn(() => 'Europe/Oslo'),
    getNow: jest.fn(() => new Date('2026-03-11T10:00:00Z')),
    log: jest.fn(),
    logDebug: jest.fn(),
    error: jest.fn(),
    ...overrides,
  };
  return { deps, actionListeners };
};

describe('registerFlowCards', () => {
  it('normalizes non-Error failures from external price flow cards', async () => {
    const { deps, actionListeners } = buildDeps({
      storeFlowPriceData: jest.fn(() => {
        throw 'boom';
      }),
    });

    registerFlowCards(deps);

    await expect(actionListeners.set_external_prices_today({ prices_json: '{}' })).rejects.toThrow('boom');
    expect(deps.error).toHaveBeenCalledWith(
      'Flow: Failed to store today prices from flow tag.',
      expect.any(Error),
    );
    expect(((deps.error as jest.Mock).mock.calls[0]?.[1] as Error).message).toBe('boom');
  });

  it('writes a clean boolean map for budget exemption flow cards without direct rebuild work', async () => {
    const settingsGet = jest.fn((key: string) => {
      if (key === 'budget_exempt_devices') return [true];
      return undefined;
    });
    const settingsSet = jest.fn();
    const { deps, actionListeners } = buildDeps({
      homey: {
        flow: {
          getActionCard: (cardId: string) => ({
            registerRunListener: (listener: (args: unknown, state?: unknown) => Promise<unknown>) => {
              actionListeners[cardId] = (args) => listener(args);
            },
            registerArgumentAutocompleteListener: jest.fn(),
            trigger: jest.fn(),
          }),
          getConditionCard: (_cardId: string) => ({
            registerRunListener: jest.fn(),
            registerArgumentAutocompleteListener: jest.fn(),
            trigger: jest.fn(),
          }),
          getTriggerCard: (_cardId: string) => ({
            registerRunListener: jest.fn(),
            registerArgumentAutocompleteListener: jest.fn(),
            trigger: jest.fn(),
          }),
        },
        settings: { get: settingsGet, set: settingsSet },
      } as FlowCardDeps['homey'],
      getSnapshot: jest.fn().mockResolvedValue([{ id: 'dev-1', name: 'Heater' }]),
    });

    registerFlowCards(deps);

    await expect(actionListeners.add_budget_exemption({ device: 'dev-1' })).resolves.toBe(true);

    expect(settingsSet).toHaveBeenCalledWith('budget_exempt_devices', { 'dev-1': true });
    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.refreshSnapshot).not.toHaveBeenCalled();
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('reports stepped-load actual step and requests a snapshot refresh plus plan rebuild', async () => {
    const { deps, actionListeners } = buildDeps({
      getSnapshot: jest.fn().mockResolvedValue([
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
  });

  it('treats an echoed stepped-load step report as a successful no-op', async () => {
    const { deps, actionListeners } = buildDeps({
      reportSteppedLoadActualStep: jest.fn(() => 'unchanged'),
      getSnapshot: jest.fn().mockResolvedValue([
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

  it('maps stepped-load power text to a configured step and strips a trailing W', async () => {
    const { deps, actionListeners } = buildDeps({
      getSnapshot: jest.fn().mockResolvedValue([
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
  });
});
