import type { PriceOptimizationSetupRead } from '../../contracts/src/priceOptimizationSettings.ts';

const load = async (
  priceOptimizationSetup: PriceOptimizationSetupRead,
  membershipByDeviceId: Readonly<Record<string, string>> = {},
) => {
  vi.resetModules();
  vi.doMock('../src/ui/prices.ts', () => ({
    getPricesReadModel: async () => ({ priceOptimizationSetup }),
  }));
  vi.doMock('../src/ui/setupPathFacts.ts', () => ({
    readSetupPath: () => ({ state: 'complete' }),
    readSetupMarket: () => ({ state: 'unavailable' }),
    isBelgianHomeOnHourlyPeriod: () => false,
  }));
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', runtimeActive: true, membershipByDeviceId }),
  }));
  vi.doMock('../src/ui/deferredObjectiveSettings.ts', () => ({
    hasLoadedDeferredObjectiveSettings: () => true,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: async () => undefined }));
  const facts = await import('../src/ui/afterSetupFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  state.devicesLoaded = true;
  state.latestDevices = [
    { id: 'thermostat', deviceType: 'temperature', powerCapable: true },
    { id: 'unmanaged', deviceType: 'temperature', powerCapable: true },
  ] as typeof state.latestDevices;
  state.managedMap = { thermostat: true };
  state.controllableMap = { thermostat: true };
  return { facts, state };
};

const resolvedSetup = (overrides: {
  enabled?: boolean;
  configuredDeviceIds?: readonly string[];
  solarSurplusDeviceIds?: readonly string[];
} = {}): PriceOptimizationSetupRead => ({
  state: 'resolved',
  setup: {
    enabled: overrides.enabled ?? true,
    configuredDeviceIds: overrides.configuredDeviceIds ?? [],
    solarSurplusDeviceIds: overrides.solarSurplusDeviceIds ?? [],
  },
});

const readFacts = (facts: Awaited<ReturnType<typeof load>>['facts']) => {
  const read = facts.readAfterSetupFacts();
  if (read.state !== 'resolved') throw new Error('Expected resolved after-setup facts.');
  return read.facts;
};

describe('after-setup facts', () => {
  it('claims nothing until the price owner returns a resolved read', async () => {
    const { facts } = await load({ state: 'unavailable' });
    await facts.loadAfterSetupFacts();
    expect(facts.readAfterSetupFacts()).toEqual({ state: 'unavailable' });
  });

  it('counts managed devices only', async () => {
    const { facts } = await load(resolvedSetup({ configuredDeviceIds: ['unmanaged'] }));
    await facts.loadAfterSetupFacts();
    expect(readFacts(facts).devices).toHaveLength(1);
    expect(readFacts(facts).devices[0]?.priceConfigured).toBe(false);
  });

  it('counts Main-home devices only when meter areas are active', async () => {
    const { facts, state } = await load(resolvedSetup({ configuredDeviceIds: ['area-heater'] }), {
      'area-heater': 'h_area',
    });
    state.latestDevices = [
      { id: 'thermostat', deviceType: 'temperature', powerCapable: true },
      { id: 'area-heater', deviceType: 'temperature', powerCapable: true },
    ] as typeof state.latestDevices;
    state.managedMap = { thermostat: true, 'area-heater': true };
    state.controllableMap = { thermostat: true, 'area-heater': true };

    await facts.loadAfterSetupFacts();

    expect(readFacts(facts).devices).toHaveLength(1);
    expect(readFacts(facts).devices[0]?.priceConfigured).toBe(false);
  });

  it('preserves the global Price opt-out', async () => {
    const { facts } = await load(resolvedSetup({ enabled: false }));
    await facts.loadAfterSetupFacts();
    expect(readFacts(facts).priceOptimizationEnabled).toBe(false);
  });

  it('treats an explicit per-device Off entry as configured', async () => {
    const { facts } = await load(resolvedSetup({ configuredDeviceIds: ['thermostat'] }));
    await facts.loadAfterSetupFacts();
    expect(readFacts(facts).devices[0]?.priceConfigured).toBe(true);
  });

  it('carries producer-resolved solar-surplus use', async () => {
    const { facts } = await load(resolvedSetup({ solarSurplusDeviceIds: ['thermostat'] }));
    await facts.loadAfterSetupFacts();
    expect(readFacts(facts).devices[0]?.usesSolarSurplus).toBe(true);
  });

  it('does not count a thermostat whose temperature control is turned off', async () => {
    const { facts, state } = await load(resolvedSetup());
    state.temperatureControlDisabledMap = { thermostat: true };
    await facts.loadAfterSetupFacts();
    expect(readFacts(facts).devices[0]).toMatchObject({ temperature: false, taskCapable: false });
  });

  it('does not reinterpret the settings UI raw state as trusted setup facts', async () => {
    const { facts, state } = await load(resolvedSetup());
    await facts.loadAfterSetupFacts();
    state.priceOptimizationSettings = {
      thermostat: null,
    } as unknown as typeof state.priceOptimizationSettings;
    expect(readFacts(facts).devices[0]).toMatchObject({ priceConfigured: false, usesSolarSurplus: false });
  });
});
