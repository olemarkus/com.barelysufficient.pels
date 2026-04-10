import { registerFlowCards, type FlowCardDeps } from '../flowCards/registerFlowCards';

const buildDeps = (overrides: Partial<FlowCardDeps> = {}) => {
  const actionListeners: Record<string, (args: unknown) => Promise<unknown>> = {};
  const createCard = (cardId: string) => ({
    registerRunListener: (listener: (args: unknown, state?: unknown) => Promise<unknown>) => {
      actionListeners[cardId] = (args) => listener(args);
    },
    registerArgumentAutocompleteListener: vi.fn(),
    trigger: vi.fn(),
  });
  const deps: FlowCardDeps = {
    homey: {
      flow: {
        getActionCard: (cardId: string) => createCard(cardId),
        getConditionCard: (_cardId: string) => createCard('condition'),
        getTriggerCard: (_cardId: string) => createCard('trigger'),
      },
      settings: { get: vi.fn(), set: vi.fn() },
    },
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
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  return { deps, actionListeners };
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

  it('reports stepped-load actual step and requests a snapshot refresh plus plan rebuild', async () => {
    const { deps, actionListeners } = buildDeps({
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

  it('maps stepped-load power text to a configured step and strips a trailing W', async () => {
    const { deps, actionListeners } = buildDeps({
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
  });
});
