import {
  createCapacitySettingsReloader,
  type CapacityScalarSettingsRead,
  type CapacitySettingsStore,
} from '../../lib/power/capacitySettingsStore';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import { TimerRegistry } from '../../lib/utils/timerRegistry';

const SCALARS: CapacityScalarSettings = {
  capacityEnabled: true, gridImportLimitKw: null, limitKw: 8, marginKw: 0.3, dryRun: false, periodMinutes: 60,
};
const RESOLVED: CapacityScalarSettingsRead = { state: 'resolved', value: SCALARS };
const RETAINED: CapacityScalarSettingsRead = { state: 'retained', value: SCALARS, askAgain: true };
const UNAVAILABLE: CapacityScalarSettingsRead = { state: 'unavailable' };

// A store that answers a scripted sequence of reads (the last one repeats).
const scriptedStore = (reads: CapacityScalarSettingsRead[]) => {
  const queue = [...reads];
  const store: CapacitySettingsStore = {
    read: vi.fn(() => (queue.length > 1 ? queue.shift() : queue[0]) as CapacityScalarSettingsRead),
    noteWrite: vi.fn((key: string) => key === 'grid_import_limit_kw'),
    readHardCapConfiguration: () => ({ state: 'resolved', configured: true }),
  };
  return store;
};

const build = (store: CapacitySettingsStore, rebuildOnChange: boolean, isStopped = () => false) => {
  const install = vi.fn();
  const rebuild = vi.fn();
  const timers = new TimerRegistry();
  const reloader = createCapacitySettingsReloader({
    store, timers, timerKey: 'capacitySettingsLoadRetry', isStopped, install, rebuild, rebuildOnChange,
  });
  return { reloader, install, rebuild, timers };
};

describe('capacity settings reloader', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rebuilds on a change only for a home whose change path has no other rebuild', () => {
    const main = build(scriptedStore([RESOLVED]), false);
    main.reloader.reload();
    expect(main.install).toHaveBeenCalledWith(RESOLVED);
    expect(main.rebuild).not.toHaveBeenCalled();
    const area = build(scriptedStore([RESOLVED]), true);
    area.reloader.reload();
    expect(area.rebuild).toHaveBeenCalledWith('change');
  });

  it('installs an unavailable read without rebuilding, then rebuilds once the retry recovers', () => {
    const { reloader, install, rebuild, timers } = build(scriptedStore([UNAVAILABLE, RESOLVED]), true);
    reloader.reload();
    expect(install).toHaveBeenCalledWith(UNAVAILABLE);
    expect(rebuild).not.toHaveBeenCalled();
    expect(timers.has('capacitySettingsLoadRetry')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(install).toHaveBeenLastCalledWith(RESOLVED);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('recovered');
  });

  it('does not rebuild on a retry that is still retained', () => {
    const { reloader, rebuild } = build(scriptedStore([RETAINED, RETAINED]), false);
    reloader.reload();
    vi.advanceTimersByTime(1_000);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('opens a fresh window on a write without reading: the handler that runs owns the reload', () => {
    const store = scriptedStore([RETAINED, RESOLVED]);
    const { reloader, rebuild } = build(store, false);
    reloader.reload();
    reloader.noteWritten('grid_import_limit_kw');
    expect(store.noteWrite).toHaveBeenCalledWith('grid_import_limit_kw');
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('re-reads when the dedupe skipped a write while the block is not reading back well-formed', () => {
    const store = scriptedStore([RETAINED, RESOLVED]);
    const { reloader, install, rebuild } = build(store, false);
    reloader.reload();
    reloader.noteWritten('grid_import_limit_kw');
    reloader.recoverAfterSkippedWrite('grid_import_limit_kw');
    expect(install).toHaveBeenLastCalledWith(RESOLVED);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('recovered');
  });

  it('spends no read on a skipped write once the block reads back well-formed, or for a key it does not carry', () => {
    const store = scriptedStore([RESOLVED]);
    const { reloader } = build(store, false);
    reloader.reload();
    reloader.recoverAfterSkippedWrite('grid_import_limit_kw');
    expect(store.read).toHaveBeenCalledTimes(1);
    const retained = scriptedStore([RETAINED]);
    const other = build(retained, false);
    other.reloader.reload();
    other.reloader.recoverAfterSkippedWrite('capacity_margin_kw');
    expect(retained.read).toHaveBeenCalledTimes(1);
  });

  it('reloads a write on a path with no dedupe as a change, after opening the window', () => {
    const store = scriptedStore([RESOLVED]);
    const { reloader, rebuild } = build(store, true);
    reloader.reloadAfterWrite('capacity_period_minutes');
    expect(store.noteWrite).toHaveBeenCalledWith('capacity_period_minutes');
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('change');
  });

  it('reads nothing once its home has stopped', () => {
    const store = scriptedStore([RESOLVED]);
    const { reloader, install } = build(store, true, () => true);
    reloader.reload();
    expect(store.read).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});
