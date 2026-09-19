import type { CapacityScalarSettings } from '../../contracts/src/capacitySettings.ts';

const running: CapacityScalarSettings = {
  limitKw: 10, marginKw: 0.2, dryRun: true, periodMinutes: 60,
};

// Fresh modules per test: the facts module keeps the saved-cap latch between
// publishes, and these tests are about the read BEFORE anything is latched.
const load = async (freshReads: ReadonlyArray<unknown | Error>) => {
  vi.resetModules();
  const pending = [...freshReads];
  const getSettingFresh = vi.fn(async () => {
    const next = pending.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  vi.doMock('../src/ui/homey.ts', () => ({ getSettingFresh, sleep: async () => undefined }));
  const { reportSetupHardCapRead } = await import('../src/ui/setupHardCapRead.ts');
  const facts = await import('../src/ui/setupPathFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  // A device PELS may limit: only then is the hard cap in force, and only then
  // does the path carry the step these tests read the verdict from.
  state.devicesLoaded = true;
  state.latestDevices = [{ id: 'heater' }] as typeof state.latestDevices;
  state.managedMap = { heater: true };
  state.controllableMap = { heater: true };
  facts.publishSetupPower({ state: 'received' });
  const hardCapStatus = () => {
    const read = facts.readSetupPath();
    if (read.state !== 'resolved') return 'loading';
    // With the meter and the device in place, a saved cap completes the path.
    return read.path === null ? 'saved: path complete' : read.path.steps.find((step) => step.id === 'hardCap')?.status;
  };
  return { reportSetupHardCapRead, getSettingFresh, hardCapStatus };
};

describe('reporting the hard cap to the setup path', () => {
  afterEach(() => { vi.doUnmock('../src/ui/homey.ts'); });

  it('settles a saved cap on one read', async () => {
    const { reportSetupHardCapRead, getSettingFresh, hardCapStatus } = await load([]);
    await reportSetupHardCapRead(8, { ...running, limitKw: 8 });
    expect(getSettingFresh).not.toHaveBeenCalled();
    expect(hardCapStatus()).toBe('saved: path complete');
  });

  it('does not take one nullish read for a home that never saved a cap', async () => {
    // Homey spells an unreadable settings store exactly as it spells an absent
    // key. A configured home's first read can come back nullish; the fresh
    // re-read finds the cap, and the owner is never sent back a step.
    const { reportSetupHardCapRead, hardCapStatus } = await load([8]);
    await reportSetupHardCapRead(undefined, { ...running, limitKw: 8 });
    expect(hardCapStatus()).toBe('saved: path complete');
  });

  it('stays loading, judging nothing, while absence is being confirmed', async () => {
    const { reportSetupHardCapRead, hardCapStatus } = await load([undefined, undefined]);
    const report = reportSetupHardCapRead(null, running);
    expect(hardCapStatus()).toBe('loading');
    await report;
    expect(hardCapStatus()).toBe('next');
  });

  it('counts a thrown re-read as unreadable, not as absence', async () => {
    const { reportSetupHardCapRead, getSettingFresh, hardCapStatus } = await load([new Error('bridge'), 8]);
    await reportSetupHardCapRead(undefined, { ...running, limitKw: 8 });
    expect(getSettingFresh).toHaveBeenCalledTimes(2);
    expect(hardCapStatus()).toBe('saved: path complete');
  });
});
