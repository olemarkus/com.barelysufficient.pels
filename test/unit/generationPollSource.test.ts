import { GenerationPollSource } from '../../lib/power/sources/generationPoll';
import type { PowerSource } from '../../lib/power/powerSource';

const buildSource = (overrides: {
  powerSource?: PowerSource;
  hasProductionCandidate?: boolean;
  readGenerationW?: () => Promise<{ state: 'measured'; watts: number } | { state: 'none' } | { state: 'unavailable' }>;
} = {}) => {
  const timers = {
    registerInterval: vi.fn((_name: string, handle: unknown) => handle),
    registerTimeout: vi.fn((_name: string, handle: unknown) => handle),
    clear: vi.fn(),
  };
  const readGenerationW = vi.fn(overrides.readGenerationW ?? (async () => ({ state: 'measured' as const, watts: 4200 })));
  const setGenerationW = vi.fn();
  const source = new GenerationPollSource({
    getPowerSource: () => overrides.powerSource ?? 'flow',
    hasProductionCandidate: () => overrides.hasProductionCandidate ?? true,
    timers: timers as never,
    readGenerationW,
    setGenerationW,
    now: () => 1_000,
    debugStructured: vi.fn(),
    error: vi.fn(),
  });
  return { source, readGenerationW, setGenerationW, timers };
};

describe('GenerationPollSource', () => {
  it('publishes the reading with its read time', async () => {
    const { source, setGenerationW } = buildSource();
    await source.pollNow();
    expect(setGenerationW).toHaveBeenCalledWith(4200, 1_000);
  });

  it('publishes a null reading — "the report carried no generation" is an observation', async () => {
    const { source, setGenerationW } = buildSource({ readGenerationW: async () => ({ state: 'none' as const }) });
    await source.pollNow();
    expect(setGenerationW).toHaveBeenCalledWith(null, 1_000);
  });

  it('makes no SDK call when the home has no device that could produce', async () => {
    // Flow homes make zero energy-API calls today and most have no PV. The gate
    // is what keeps it that way; without it every flow install pays a 10 s poll.
    const { source, readGenerationW, setGenerationW } = buildSource({ hasProductionCandidate: false });
    await source.pollNow();
    expect(readGenerationW).not.toHaveBeenCalled();
    expect(setGenerationW).not.toHaveBeenCalled();
  });

  it('does not run on the homey_energy source, where the main poll already co-samples', async () => {
    const { source, setGenerationW, timers } = buildSource({ powerSource: 'homey_energy' });
    source.start();
    expect(timers.registerInterval).not.toHaveBeenCalled();
    expect(setGenerationW).not.toHaveBeenCalled();
  });

  it('never publishes a FAILED read as "producing nothing"', async () => {
    // On this source net keeps arriving from the Flow card regardless, so an SDK
    // blip published as a fresh zero-generation observation would overwrite a
    // good reading and sail past the freshness window into the accrual. Leaving
    // the held value alone lets it age out honestly instead.
    const { source, setGenerationW } = buildSource({
      readGenerationW: async () => ({ state: 'unavailable' as const }),
    });
    await source.pollNow();
    expect(setGenerationW).not.toHaveBeenCalled();
  });

  it('discards a reading whose poll was superseded mid-flight', async () => {
    // The read is deliberately pure so this check can happen BEFORE anything is
    // published: a poll that was awaiting the SDK when the source changed must
    // not leave its reading in observer state for the flow ingest to pick up.
    const { source, setGenerationW } = buildSource({
      readGenerationW: async () => {
        source.stop(); // bumps the generation counter while the read is in flight
        return { state: 'measured' as const, watts: 4200 };
      },
    });
    await source.pollNow();
    expect(setGenerationW).not.toHaveBeenCalled();
  });

  it('discards an OVERLAPPING slow read that a newer one already answered', async () => {
    // A read slower than the 10 s interval overlaps its successor. Completing
    // last must not mean winning: its measurement is the older of the two.
    const pending: Array<(r: { state: 'measured'; watts: number }) => void> = [];
    const { source, setGenerationW } = buildSource({
      readGenerationW: () => new Promise((resolve) => { pending.push(resolve); }),
    });
    const first = source.pollNow();
    const second = source.pollNow();
    pending[1]?.({ state: 'measured', watts: 4200 });
    await second;
    pending[0]?.({ state: 'measured', watts: 1000 });
    await first;

    expect(setGenerationW).toHaveBeenCalledTimes(1);
    expect(setGenerationW).toHaveBeenCalledWith(4200, 1_000);
  });

  it('lets a FAILED newer read retire an older overlapping one', async () => {
    // The fence tracks the latest read that SETTLED, not the latest that
    // published. A newer read failing still proves a newer answer arrived, so
    // the older read completing afterwards is stale — publishing it would be
    // exactly the overlap the fence exists to stop.
    const pending: Array<(r: { state: 'measured'; watts: number } | { state: 'unavailable' }) => void> = [];
    const { source, setGenerationW } = buildSource({
      readGenerationW: () => new Promise((resolve) => { pending.push(resolve); }),
    });
    const first = source.pollNow();
    const second = source.pollNow();
    pending[1]?.({ state: 'unavailable' });
    await second;
    pending[0]?.({ state: 'measured', watts: 1000 });
    await first;

    expect(setGenerationW).not.toHaveBeenCalled();
  });

  it('discards a reading when the power source changed under it', async () => {
    let powerSource: PowerSource = 'flow';
    const timers = {
      registerInterval: vi.fn((_n: string, h: unknown) => h),
      registerTimeout: vi.fn((_n: string, h: unknown) => h),
      clear: vi.fn(),
    };
    const setGenerationW = vi.fn();
    const source = new GenerationPollSource({
      getPowerSource: () => powerSource,
      hasProductionCandidate: () => true,
      timers: timers as never,
      readGenerationW: async () => {
        powerSource = 'homey_energy';
        return { state: 'measured' as const, watts: 4200 };
      },
      setGenerationW,
      now: () => 1_000,
      debugStructured: vi.fn(),
      error: vi.fn(),
    });
    await source.pollNow();
    expect(setGenerationW).not.toHaveBeenCalled();
  });
});
