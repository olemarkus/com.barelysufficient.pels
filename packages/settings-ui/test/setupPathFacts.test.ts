import type { CapacityScalarSettings } from '../../contracts/src/capacitySettings.ts';

// The module holds the facts between publishes, so each test loads a fresh copy
// (and the `state` it reads) rather than inheriting the last test's.
const load = async () => {
  vi.resetModules();
  const facts = await import('../src/ui/setupPathFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  return { facts, state };
};

const NEVER = { state: 'never' as const, remedy: 'No power readings yet.' };
const RECEIVED = { state: 'received' as const };

const running: CapacityScalarSettings = {
  limitKw: 10, marginKw: 0.2, dryRun: true, periodMinutes: 60,
};

const hardCapDetail = (facts: Awaited<ReturnType<typeof load>>['facts']): string | undefined => {
  const read = facts.readSetupPath();
  return read.state === 'resolved'
    ? read.path?.steps.find((step) => step.id === 'hardCap')?.detail
    : undefined;
};

describe('setup path facts', () => {
  it('judges nothing until the readings, the hard cap and the device list have all arrived', async () => {
    const { facts, state } = await load();
    expect(facts.readSetupPath()).toEqual({ state: 'loading' });
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(undefined, running);
    // A guess here would tell an owner with ten managed devices to go choose some.
    expect(facts.readSetupPath()).toEqual({ state: 'loading' });
    state.devicesLoaded = true;
    expect(facts.readSetupPath().state).toBe('resolved');
  });

  it('keeps a saved hard cap saved through an unreadable settings read', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    // A device PELS may limit puts the hard cap in force, and so on the path.
    state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
    state.managedMap = { heater: true };
    state.controllableMap = { heater: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(8, { ...running, limitKw: 8, marginKw: 0.4 });
    // The SDK's transient answer for a key it could not read; the running
    // scalars are the app's last-good and still refresh.
    facts.publishSetupHardCapRead(undefined, { ...running, limitKw: 8, marginKw: 0.5 });
    expect(hardCapDetail(facts)).toBe('8 kW hourly average, 0.5 kW safety margin');
  });

  it('counts only managed devices that still exist', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
    // A managed flag for a device that has since left the home is not a device.
    state.managedMap = { heater: true, gone: true };
    state.controllableMap = { gone: true };
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(undefined, running);
    const read = facts.readSetupPath();
    const devices = read.state === 'resolved' ? read.path?.steps.find((step) => step.id === 'devices') : undefined;
    expect(devices?.detail).toBe('1 device managed');
  });

  it('runs listeners only when the path actually moved', async () => {
    const { facts, state } = await load();
    state.devicesLoaded = true;
    const listener = vi.fn();
    facts.onSetupPathChange(listener);
    facts.publishSetupPower(NEVER);
    facts.publishSetupHardCapRead(undefined, running);
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
      loaded.facts.publishSetupHardCapRead(undefined, running);
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
      facts.publishSetupHardCapRead(8, { ...running, limitKw: 8 });
      expect(facts.isSimulationCarriedBySetupPath(true)).toBe(false);
    });
  });

  describe('the no-readings banner standing down', () => {
    const neverReceived = async () => {
      const loaded = await load();
      loaded.state.devicesLoaded = true;
      loaded.facts.publishSetupPower(NEVER);
      loaded.facts.publishSetupHardCapRead(undefined, running);
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
