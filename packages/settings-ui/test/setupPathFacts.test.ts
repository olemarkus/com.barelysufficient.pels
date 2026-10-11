import type { CapacityScalarSettings } from '../../contracts/src/capacitySettings.ts';

// The module holds the facts between publishes, so each test loads a fresh copy
// (and the `state` it reads) rather than inheriting the last test's.
// Prices nothing uses: the Prices step stays out of these tests unless one
// publishes otherwise.
const NO_PRICE_USE = {
  respondToPrices: false,
  budgetShapesByPrice: false,
  status: { state: 'complete' as const, summary: 'Flow' },
};

const loadUnpublished = async (membershipByDeviceId: Readonly<Record<string, string>> = {}) => {
  vi.resetModules();
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', runtimeActive: true, membershipByDeviceId }),
    subscribeToHomeScope: () => undefined,
  }));
  const facts = await import('../src/ui/setupPathFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  return { facts, state };
};

const load = async (membershipByDeviceId: Readonly<Record<string, string>> = {}) => {
  const loaded = await loadUnpublished(membershipByDeviceId);
  loaded.facts.publishSetupPrices(NO_PRICE_USE);
  return loaded;
};

const NEVER = { state: 'never' as const, remedy: 'No power readings yet.' };
const RECEIVED = { state: 'received' as const };

const running: CapacityScalarSettings = {
  capacityEnabled: true,
  gridImportLimitKw: null,
  limitKw: 10, marginKw: 0.2, dryRun: true, periodMinutes: 60,
};

const hardCapDetail = (facts: Awaited<ReturnType<typeof load>>['facts']): string | undefined => {
  const read = facts.readSetupPath();
  return read.state === 'open'
    ? read.path.steps.find((step) => step.id === 'hardCap')?.detail
    : undefined;
};

describe('setup path facts', () => {
  it('keeps the Belgian period recommendation when both constraints are enabled', async () => {
    const { facts } = await load();
    facts.publishSetupMarket({ state: 'resolved', country: 'BE' });
    facts.publishSetupHardCapRead(true, { ...running, gridImportLimitKw: 3.3 });
    expect(facts.isBelgianHomeOnHourlyPeriod()).toBe(true);
    facts.publishSetupHardCapRead(true, { ...running, gridImportLimitKw: 3.3, capacityEnabled: false });
    expect(facts.isBelgianHomeOnHourlyPeriod()).toBe(false);
  });

  it('names both limits in the Limits row when both are on, and only the grid limit otherwise', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
    state.managedMap = { heater: true };
    state.controllableMap = { heater: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(true, { ...running, gridImportLimitKw: 3.3, limitKw: 5, marginKw: 0.3 });
    expect(hardCapDetail(facts)).toBe('3.3 kW grid import limit, 5 kW hard cap (hourly average), 0.3 kW safety margin');
    facts.publishSetupHardCapRead(true, { ...running, gridImportLimitKw: 3.3, capacityEnabled: false });
    expect(hardCapDetail(facts)).toBe('3.3 kW grid import limit');
    facts.publishSetupMarket({ state: 'resolved', country: 'BE' });
    facts.publishSetupHardCapRead(true, { ...running, gridImportLimitKw: 3.3, limitKw: 5, marginKw: 0.3 });
    expect(hardCapDetail(facts)).toBe(
      '3.3 kW grid import limit, 5 kW hard cap (hourly average), 0.3 kW safety margin. In Flanders, use the 15-minute average.',
    );
  });

  it('judges nothing until the readings, the hard cap, the prices and the device list have all arrived', async () => {
    const { facts, state } = await loadUnpublished();
    expect(facts.readSetupPath()).toEqual({ state: 'loading' });
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(false, running);
    // A guess here would tell an owner with ten managed devices to go choose some.
    expect(facts.readSetupPath()).toEqual({ state: 'loading' });
    state.devicesLoaded = true;
    expect(facts.readSetupPath()).toEqual({ state: 'loading' });
    facts.publishSetupPrices(NO_PRICE_USE);
    expect(facts.readSetupPath().state).toBe('open');
  });

  describe('Prices step', () => {
    let defaultPriceOptimizationConfig: Awaited<typeof import('../src/ui/state.ts')>['defaultPriceOptimizationConfig'];
    const OPEN_NORWAY = {
      state: 'open' as const,
      summary: 'Norway, without your grid tariff. PELS uses NO1 and Strømstøtte until you choose.',
    };

    const configuredHome = async () => {
      const loaded = await load();
      ({ defaultPriceOptimizationConfig } = await import('../src/ui/state.ts'));
      const { facts, state } = loaded;
      state.devicesLoaded = true;
      state.latestDevices = [{ id: 'heater', deviceType: 'temperature' }] as typeof state.latestDevices;
      state.managedMap = { heater: true };
      state.controllableMap = { heater: true };
      state.priceOptimizationSettings = {};
      state.deferredObjectiveSettings = { objectivesByDeviceId: {} } as typeof state.deferredObjectiveSettings;
      facts.publishSetupPower(RECEIVED);
      facts.publishSetupHardCapRead(true, running);
      return loaded;
    };

    const pricesStep = (facts: Awaited<ReturnType<typeof load>>['facts']) => {
      const read = facts.readSetupPath();
      return read.state === 'open' ? read.path.steps.find((step) => step.id === 'prices') : undefined;
    };

    it('asks for prices once a managed device responds to them', async () => {
      const { facts, state } = await configuredHome();
      facts.publishSetupPrices({ respondToPrices: true, budgetShapesByPrice: false, status: OPEN_NORWAY });
      expect(facts.readSetupPath()).toEqual({ state: 'complete' });

      state.priceOptimizationSettings = { heater: { ...defaultPriceOptimizationConfig, enabled: true } };

      expect(pricesStep(facts)).toEqual(expect.objectContaining({
        status: 'next',
        title: 'Prices',
        detail: OPEN_NORWAY.summary,
        target: { panel: 'electricity-prices', anchor: '#price-source-select' },
      }));
    });

    it('asks for prices for a Smart task or a budget that shapes toward cheaper hours', async () => {
      const { facts, state } = await configuredHome();
      state.deferredObjectiveSettings = {
        objectivesByDeviceId: { heater: { enabled: true, deadlineAtMs: Date.now() + 3_600_000 } },
      } as unknown as typeof state.deferredObjectiveSettings;
      facts.publishSetupPrices({ respondToPrices: true, budgetShapesByPrice: false, status: OPEN_NORWAY });
      expect(pricesStep(facts)?.status).toBe('next');

      state.deferredObjectiveSettings = { objectivesByDeviceId: {} } as typeof state.deferredObjectiveSettings;
      facts.publishSetupPrices({ respondToPrices: true, budgetShapesByPrice: true, status: OPEN_NORWAY });
      expect(pricesStep(facts)?.status).toBe('next');
    });

    it('asks nothing for a Smart task that has ended, or price control on a device without a temperature', async () => {
      const { facts, state } = await configuredHome();
      state.deferredObjectiveSettings = {
        objectivesByDeviceId: { heater: { enabled: true, deadlineAtMs: Date.now() - 60_000 } },
      } as unknown as typeof state.deferredObjectiveSettings;
      state.latestDevices = [{ id: 'heater', deviceType: 'onoff' }] as typeof state.latestDevices;
      state.priceOptimizationSettings = { heater: { ...defaultPriceOptimizationConfig, enabled: true } };
      facts.publishSetupPrices({ respondToPrices: true, budgetShapesByPrice: false, status: OPEN_NORWAY });

      expect(facts.readSetupPath()).toEqual({ state: 'complete' });
    });

    it('asks for nothing while Respond to prices is off', async () => {
      // Every price behaviour waits on it, so with it off nothing uses prices.
      const { facts, state } = await configuredHome();
      state.priceOptimizationSettings = { heater: { ...defaultPriceOptimizationConfig, enabled: true } };
      facts.publishSetupPrices({ respondToPrices: false, budgetShapesByPrice: true, status: OPEN_NORWAY });

      expect(facts.readSetupPath()).toEqual({ state: 'complete' });
    });

    it('is done once the owner has set prices up', async () => {
      const { facts } = await configuredHome();
      facts.publishSetupPrices({
        respondToPrices: true,
        budgetShapesByPrice: true,
        status: { state: 'complete', summary: 'Norway · ARVA AS · NO4 · Norgespris' },
      });

      expect(facts.readSetupPath()).toEqual({ state: 'complete' });
    });
  });

  it('reports a bounded first-read failure instead of loading forever', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    facts.publishSetupPowerUnavailable();
    facts.publishSetupHardCapUnavailable();

    expect(facts.readSetupPath()).toEqual({ state: 'unavailable' });
  });

  it('preserves last-good setup facts across later read failures', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(false, running);
    facts.publishSetupPowerUnavailable();
    facts.publishSetupHardCapUnavailable();

    expect(facts.readSetupPath().state).toBe('open');
  });

  it('keeps a saved hard cap saved through an unreadable settings read', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    // A device PELS may limit puts the hard cap in force, and so on the path.
    state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
    state.managedMap = { heater: true };
    state.controllableMap = { heater: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(true, { ...running, limitKw: 8, marginKw: 0.4 });
    facts.publishSetupHardCapRead(true, { ...running, limitKw: 8, marginKw: 0.5 });
    expect(hardCapDetail(facts)).toBe('8 kW hard cap (hourly average), 0.5 kW safety margin');
  });

  it('counts only managed devices that still exist', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
    // A managed flag for a device that has since left the home is not a device.
    state.managedMap = { heater: true, gone: true };
    state.controllableMap = { gone: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(false, running);
    const read = facts.readSetupPath();
    const devices = read.state === 'open' ? read.path.steps.find((step) => step.id === 'devices') : undefined;
    expect(devices?.detail).toBe('1 device managed');
  });

  it('counts only Main-home devices when meter areas are active', async () => {
    const { facts, state } = await load({ areaHeater: 'area-1' });
    state.devicesLoaded = true;
    state.latestDevices = [{ id: 'mainHeater' }, { id: 'areaHeater' }] as typeof state.latestDevices;
    state.managedMap = { mainHeater: true, areaHeater: true };
    state.controllableMap = { mainHeater: false, areaHeater: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(false, running);
    const read = facts.readSetupPath();
    const devices = read.state === 'open'
      ? read.path.steps.find((step) => step.id === 'devices')
      : undefined;
    expect(devices?.detail).toBe('1 device managed');
    expect(read.state === 'open' && read.path.steps.some((step) => step.id === 'hardCap')).toBe(false);
  });

  it('keeps setup complete when a newly managed device has no saved priority', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    state.latestDevices = [{ id: 'bedroom' }] as typeof state.latestDevices;
    state.managedMap = { bedroom: true };
    state.controllableMap = { bedroom: true };
    state.loadedModeHomeId = 'main';
    state.activeMode = 'Home';
    state.capacityPriorities = { Home: { bedroom: 1 } };
    facts.publishSetupPower(RECEIVED);
    facts.publishSetupHardCapRead(true, running);
    expect(facts.readSetupPath()).toEqual({ state: 'complete' });

    state.latestDevices.push({ id: 'pool' } as typeof state.latestDevices[number]);
    state.managedMap.pool = true;
    state.controllableMap.pool = true;
    expect(facts.readSetupPath()).toEqual({ state: 'complete' });

    // Automatic ordering also completes setup before anyone saves any order.
    state.capacityPriorities = {};
    expect(facts.readSetupPath()).toEqual({ state: 'complete' });
  });

  it('runs listeners only when the path actually moved', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    const listener = vi.fn();
    facts.onSetupPathChange(listener);
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(false, running);
    const afterFacts = listener.mock.calls.length;
    // A device-list tick, and the same power fact published again, move nothing.
    facts.notifySetupPathChange();
    facts.publishSetupPower(NEVER);
    expect(listener).toHaveBeenCalledTimes(afterFacts);
    facts.publishSetupPower(RECEIVED);
    facts.publishSetupPower(RECEIVED);
    expect(listener).toHaveBeenCalledTimes(afterFacts + 1);
  });

  describe('the simulation banner standing down', () => {
    const openPath = async () => {
      const loaded = await load();
      loaded.state.devicesLoaded = true;
      loaded.state.latestDevices = [{ id: 'heater' }] as typeof loaded.state.latestDevices;
      loaded.facts.publishSetupPower(NEVER);
      loaded.facts.publishSetupHardCapRead(false, running);
      return loaded;
    };

    it('never happens while the meter-area roster is unread or has areas', async () => {
      const { facts, state } = await openPath();
      state.activePanel = 'overview';
      expect(facts.isSimulationCarriedBySetupPath(false)).toBe(false);
    });

    it('happens on every panel while nothing is managed', async () => {
      const { facts, state } = await openPath();
      state.activePanel = 'budget';
      expect(facts.isSimulationCarriedBySetupPath(true)).toBe(true);
    });

    it('happens only where the card is on screen once a device is managed', async () => {
      const { facts, state } = await openPath();
      state.managedMap = { heater: true };
      state.activePanel = 'budget';
      expect(facts.isSimulationCarriedBySetupPath(true)).toBe(false);
      state.activePanel = 'overview';
      expect(facts.isSimulationCarriedBySetupPath(true)).toBe(true);
    });

    it('ends with the path: a configured home keeps its banner', async () => {
      const { facts, state } = await openPath();
      state.managedMap = { heater: true };
      state.activePanel = 'overview';
      facts.publishSetupPower(RECEIVED);
      facts.publishSetupHardCapRead(true, { ...running, limitKw: 8 });
      expect(facts.isSimulationCarriedBySetupPath(true)).toBe(false);
    });
  });

  describe('the no-readings banner standing down', () => {
    const neverReceived = async () => {
      const loaded = await load();
      loaded.state.devicesLoaded = true;
      loaded.facts.publishSetupPower(NEVER);
      loaded.facts.publishSetupHardCapRead(false, running);
      return loaded;
    };

    it('happens only where the card is on screen', async () => {
      const { facts, state } = await neverReceived();
      state.activePanel = 'overview';
      expect(facts.isNoReadingsCarriedBySetupPath(true)).toBe(true);
      // Budget has no card: without the banner nothing there would say why it is empty.
      state.activePanel = 'budget';
      expect(facts.isNoReadingsCarriedBySetupPath(true)).toBe(false);
    });

    it('never happens for readings that had arrived and stopped', async () => {
      // That is an alert about a working setup, not a setup step. The path is
      // still open here (no hard cap saved), and the banner must still show.
      const { facts, state } = await neverReceived();
      state.activePanel = 'overview';
      facts.publishSetupPower(RECEIVED);
      expect(facts.isNoReadingsCarriedBySetupPath(true)).toBe(false);
    });

    it('never happens while the meter-area roster is unread or has areas', async () => {
      const { facts, state } = await neverReceived();
      state.activePanel = 'overview';
      expect(facts.isNoReadingsCarriedBySetupPath(false)).toBe(false);
    });
  });
});
