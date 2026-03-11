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

  it('rebuilds the plan and ignores non-record settings for budget exemption flow cards', async () => {
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
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlan).toHaveBeenCalledWith('budget_exemption');
  });
});
