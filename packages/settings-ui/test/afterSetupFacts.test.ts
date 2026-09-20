// Fresh modules per test: the facts module remembers its confirmed read, and
// these tests are about what is claimed BEFORE and AFTER that read lands.
const load = async (reads: { first: unknown | Error; fresh?: ReadonlyArray<unknown | Error> }) => {
  vi.resetModules();
  const pending = [...(reads.fresh ?? [])];
  const settle = (value: unknown | Error) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  vi.doMock('../src/ui/homey.ts', async () => ({
    ...(await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts')),
    getSetting: () => settle(reads.first),
    getSettingFresh: () => settle(pending.shift()),
    sleep: async () => undefined,
  }));
  vi.doMock('../src/ui/logging.ts', async () => ({
    ...(await vi.importActual<typeof import('../src/ui/logging.ts')>('../src/ui/logging.ts')),
    logSettingsError: async () => undefined,
  }));
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

const devicesOf = (read: ReturnType<Awaited<ReturnType<typeof load>>['facts']['readAfterSetupFacts']>) => (
  read.devices.state === 'known' ? read.devices.value : 'unknown'
);

describe('after-setup facts', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/homey.ts');
    vi.doUnmock('../src/ui/logging.ts');
  });

  it('claims nothing about Price or solar until the price settings have been read', async () => {
    const { facts } = await load({ first: {} });
    expect(devicesOf(facts.readAfterSetupFacts())).toBe('unknown');
    await facts.loadAfterSetupFacts();
    expect(devicesOf(facts.readAfterSetupFacts())).toEqual([{
      temperature: true, limitable: true, taskCapable: true, priceEnabled: false, usesSolarSurplus: false,
    }]);
  });

  it('counts managed devices only', async () => {
    const { facts } = await load({ first: { unmanaged: { enabled: true } } });
    await facts.loadAfterSetupFacts();
    // The unmanaged thermostat follows prices in the stored map, but PELS does
    // not manage it, so it neither applies nor counts as "already in use".
    expect(devicesOf(facts.readAfterSetupFacts())).toHaveLength(1);
  });

  it('does not take one nullish read for a home that uses neither feature', async () => {
    // A configured home whose first read failed: the fresh re-read finds Price on.
    const { facts } = await load({ first: undefined, fresh: [{ thermostat: { enabled: true, surplusWilling: true } }] });
    await facts.loadAfterSetupFacts();
    expect(devicesOf(facts.readAfterSetupFacts())).toMatchObject([{ priceEnabled: true, usesSolarSurplus: true }]);
  });

  it('accepts a key that stays absent as a home using neither', async () => {
    const { facts } = await load({ first: undefined, fresh: [undefined, null] });
    await facts.loadAfterSetupFacts();
    expect(devicesOf(facts.readAfterSetupFacts())).toMatchObject([{ priceEnabled: false, usesSolarSurplus: false }]);
  });

  it('stays unknown when the confirming re-read fails: a failed read is not absence', async () => {
    // Nullish first, then a re-read that throws. Nothing was learned about the
    // key, so nothing may be claimed about Price or solar.
    const { facts } = await load({ first: undefined, fresh: [undefined, new Error('bridge')] });
    await facts.loadAfterSetupFacts();
    expect(devicesOf(facts.readAfterSetupFacts())).toBe('unknown');
  });

  it('does not count a thermostat whose temperature control is turned off', async () => {
    const { facts, state } = await load({ first: {} });
    state.temperatureControlDisabledMap = { thermostat: true };
    await facts.loadAfterSetupFacts();
    // Price cannot move it and it cannot take a heating task.
    expect(devicesOf(facts.readAfterSetupFacts())).toMatchObject([{ temperature: false, taskCapable: false }]);
  });

  it('stays unknown when the settings cannot be read at all', async () => {
    const { facts } = await load({ first: new Error('bridge') });
    await facts.loadAfterSetupFacts();
    expect(devicesOf(facts.readAfterSetupFacts())).toBe('unknown');
  });

  it('lets a toggle made this session win over the earlier read', async () => {
    const { facts, state } = await load({ first: {} });
    await facts.loadAfterSetupFacts();
    state.priceOptimizationSettings = {
      thermostat: { enabled: true, cheapDelta: 2, expensiveDelta: -2, surplusWilling: false },
    } as typeof state.priceOptimizationSettings;
    expect(devicesOf(facts.readAfterSetupFacts())).toMatchObject([{ priceEnabled: true }]);
  });

  it('claims nothing about Smart tasks until their settings have loaded', async () => {
    const { facts } = await load({ first: {} });
    expect(facts.readAfterSetupFacts().smartTaskConfigured).toEqual({ state: 'unknown' });
  });
});
