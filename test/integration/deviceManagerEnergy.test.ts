import type Homey from 'homey';
import {
  extractLiveMeterItems,
  extractLiveMeterPowerWatts,
} from '../../lib/device/managerEnergy';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { mockHomeyInstance } from '../mocks/homey';
import { fetchLiveGenerationW, fetchLiveMeterItems, fetchLivePowerReport } from '../../lib/device/transport/managerFetch';
import {
  fetchLivePowerReport as fetchTransportLivePowerReport,
} from '../../lib/device/transport/snapshotRefresh';
import { pollHomePowerWithMeterFanOut } from '../../lib/device/transport/homePowerPoll';
import type { TransportContext } from '../../lib/device/transport/transportContext';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import type { Logger } from '../../lib/utils/types';

describe('extractLiveMeterPowerWatts', () => {
  it('matches the id in a cumulative item (Homey-marked whole-home meter)', () => {
    const report = {
      items: [
        { type: 'device', id: 'other', values: { W: 100 } },
        { type: 'cumulative', id: 'han-meter', values: { W: 443 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(443);
  });

  it('matches the id in a device item (unmarked meter)', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(3200);
  });

  it('passes negative watts through (export on a net meter)', () => {
    const report = {
      items: [{ type: 'device', id: 'han-meter', values: { W: -1500 } }],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(-1500);
  });

  it('never falls back to another cumulative item when the id is absent', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'other', values: { W: 100 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'gone-meter')).toBeNull();
  });

  it('ignores a matching id on a non-power item type', () => {
    const report = {
      items: [{ type: 'zone', id: 'zone-id', values: { W: 500 } }],
    };
    expect(extractLiveMeterPowerWatts(report, 'zone-id')).toBeNull();
  });

  it('returns null for non-finite or missing readings on the matched item', () => {
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: NaN } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: Infinity } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: null } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm' }],
    }, 'm')).toBeNull();
  });

  it('returns null for malformed reports', () => {
    expect(extractLiveMeterPowerWatts(null, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({}, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({ items: [null, 42, 'junk'] }, 'm')).toBeNull();
  });
});

describe('extractLiveMeterItems', () => {
  it('lists cumulative and device items with an id, preserving report order', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: 443 } },
        { type: 'device', id: 'subpanel', values: { W: 120 } },
        { type: 'device', id: 'plug', values: { W: 0 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'subpanel', type: 'device' },
      { id: 'plug', type: 'device' },
    ]);
  });

  it('lists a meter regardless of its reading — a momentarily non-finite/absent W stays pickable', () => {
    // The reader resolves W per poll; listing must not gate on this poll's value.
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: NaN } },
        { type: 'device', id: 'subpanel' },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'subpanel', type: 'device' },
    ]);
  });

  it('drops an id-less item at the parse, and omits other item types', () => {
    const report = {
      items: [
        { type: 'cumulative', values: { W: 443 } },
        { type: 'generator', id: 'pv', values: { W: 900 } },
        { type: 'zone', id: 'z1', values: { W: 500 } },
        { type: 'device', id: 'han', values: { W: 100 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([{ id: 'han', type: 'device' }]);
  });

  it('dedupes by id, first occurrence winning', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: 443 } },
        { type: 'device', id: 'han', values: { W: 443 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([{ id: 'han', type: 'cumulative' }]);
  });

  it('returns an empty list for malformed reports', () => {
    expect(extractLiveMeterItems(null)).toEqual([]);
    expect(extractLiveMeterItems({})).toEqual([]);
    expect(extractLiveMeterItems({ items: [null, 42, 'junk', { type: 'device', id: 42 }] })).toEqual([]);
  });
});

describe('fetchLivePowerReport', () => {
  const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns both device power and home power from the REST API', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'device', id: 'dev1', values: { W: 800 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
      additionalMeterDeviceIds: [],
    });

    expect(result).toMatchObject({
      state: 'measured',
      byDeviceId: { dev1: 800 },
      home: { state: 'resolved', watts: 3200, meterDeviceId: 'meter-main' },
      deviceCount: 1,
    });
  });

  it('resolves the whole-home reading from the selected meter, ignoring the cumulative item', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'resolved', meterDeviceId: 'han-meter' },
      additionalMeterDeviceIds: [],
    });

    expect(result).toMatchObject({
      home: { state: 'resolved', watts: 3200, meterDeviceId: 'han-meter' },
      byDeviceId: { 'han-meter': 3200 },
    });
  });

  it('leaves the whole-home half unavailable on an unavailable selection while keeping the per-device lanes', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'unavailable' },
      additionalMeterDeviceIds: [],
    });

    // No guessing: there is no Automatic to fall back to, so an unknown
    // authority yields no whole-home reading — never another meter's watts.
    expect(result).toMatchObject({
      state: 'measured',
      home: { state: 'unavailable' },
      byDeviceId: { dev1: 800 },
    });
  });

  it('leaves the whole-home half unavailable when the selected meter is missing, keeping the rest of the report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      totalGenerated: { W: 600 },
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'resolved', meterDeviceId: 'gone-meter' },
      additionalMeterDeviceIds: [],
    });

    expect(result).toMatchObject({
      state: 'measured',
      home: { state: 'unavailable' },
      byDeviceId: { dev1: 800 },
      generation: { state: 'measured', watts: 600 },
    });
  });

  it('reports an unavailable read when REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
      additionalMeterDeviceIds: [],
    });

    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports an unavailable read for a payload that is not a report — never a measurement of nothing', async () => {
    for (const payload of [undefined, '', {}, { items: 'nope' }]) {
      vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(payload);
      const result = await fetchLivePowerReport({
        logger,
        meterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
        additionalMeterDeviceIds: [],
      });
      expect(result).toEqual({ state: 'unavailable' });
      await expect(fetchLiveGenerationW(logger)).resolves.toEqual({ state: 'unavailable' });
    }
    expect(logger.error).toHaveBeenCalledWith({ event: 'energy_live_report_unavailable', reasonCode: 'malformed_payload' });
    expect(logger.error).toHaveBeenCalledWith({ event: 'energy_live_generation_unavailable', reasonCode: 'malformed_payload' });
  });

  it('reports an unavailable read on API error', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));

    const result = await fetchLivePowerReport({
      logger,
      meterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
      additionalMeterDeviceIds: [],
    });

    expect(result).toEqual({ state: 'unavailable' });
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('transport Main-meter authority', () => {
  const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a captured unavailable authority and preserves other report lanes', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'automatic-main', values: { W: 9_999 } },
        { type: 'device', id: 'sub-meter', values: { W: 1_200 } },
      ],
    });
    const ctx = {
      logger,
      automaticHomeMeterState: { preferredDeviceId: null },
      // The live authority has recovered by the time the SDK call starts, but
      // the refresh cycle must remain bound to its captured start selection.
      resolveMainMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
      providers: {
        getAdditionalMeterDeviceIds: () => ['sub-meter'],
      },
    } as unknown as TransportContext;

    const report = await fetchTransportLivePowerReport(ctx, { state: 'unavailable' });

    expect(report).toMatchObject({
      state: 'measured',
      home: { state: 'unavailable' },
      byDeviceId: { 'sub-meter': 1_200 },
      additionalMeterPowerW: { 'sub-meter': 1_200 },
    });
  });

  it('stamps the poll sample with the resolved selection identity', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3_000 } }],
    });
    const ctx = {
      logger,
      resolveMainMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }),
      providers: {},
    } as unknown as TransportContext;

    await expect(pollHomePowerWithMeterFanOut(ctx, () => true)).resolves.toEqual({
      powerW: 3_000,
      meterDeviceId: 'meter-main',
    });
  });

  it('fans out area readings while the Main selection is unavailable', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
        { type: 'cumulative', id: 'meter-area', values: { W: 1_200 } },
      ],
    });
    const onAdditionalMeterReadings = vi.fn();
    const ctx = {
      logger,
      resolveMainMeterSelection: () => ({ state: 'unavailable' as const }),
      providers: {
        getAdditionalMeterDeviceIds: () => ['meter-area'],
        onAdditionalMeterReadings,
      },
    } as unknown as TransportContext;

    await expect(pollHomePowerWithMeterFanOut(ctx, () => true)).resolves.toBeNull();
    expect(onAdditionalMeterReadings).toHaveBeenCalledWith({ 'meter-area': 1_200 }, expect.any(Number));
  });
});

// The resolved whole-home meter IDENTITY leaves the transport ON the sample,
// never as a read-time dispatch: publication to membership happens only at the
// admitted sample ingest (`PowerSamplePipeline`), so the identity, the watts,
// and their timestamp move as one operation and a read whose sample is
// discarded (post-actuation refresh, post-write re-read, superseded poll)
// claims nothing — by construction, not by a gate.
describe('resolved home meter identity on the sample', () => {
  const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Drives the REAL `DeviceTransport.refreshSnapshot` pipeline, not the
  // wrapper in isolation: this return value is what `AppSnapshotHelpers` hands
  // to `recordPowerSample`, so the identity riding it is what the pipeline
  // publishes iff the sample is admitted.
  it('carries the sampled identity on a real snapshot refresh return', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'm-area', values: { W: 4_200 } }],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'm-area' }) },
    );

    const sample = await transport.refreshSnapshot({
      mainMeterSelection: { state: 'resolved', meterDeviceId: 'm-area' },
    });

    expect(sample).toEqual({
      powerW: 4_200,
      meterDeviceId: 'm-area',
    });
  });

  it('yields no sample for an id-less item — it is dropped at the parse', async () => {
    // An item without an id is malformed: no selection can name it, so it
    // resolves nothing and no whole-home sample exists.
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', values: { W: 4_200 } }],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }) },
    );

    const sample = await transport.refreshSnapshot({
      mainMeterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
    });

    expect(sample).toBeNull();
  });

  it('carries the identity on the poll path sample too', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: 2_800 } }],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }) },
    );

    await expect(transport.pollHomePowerW()).resolves.toEqual({
      powerW: 2_800,
      meterDeviceId: 'meter-main',
    });
  });

  it('reads no whole-home sample at all under an unavailable authority', async () => {
    // No authority, no whole-home sample: nobody records watts under a meter
    // nobody chose — the only inventable answer was Automatic, and it is gone.
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'm-area', values: { W: 4_200 } }],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
    );

    await expect(transport.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } })).resolves.toBeNull();
  });

  it('does NOT read live power on a fast refresh, so no sample and no identity exist', async () => {
    const getEnergyLiveReport = vi.spyOn(homeyApi, 'getEnergyLiveReport');
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }) },
    );

    const sample = await transport.refreshSnapshot({
      includeLivePower: false,
      mainMeterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
    });

    expect(getEnergyLiveReport).not.toHaveBeenCalled();
    expect(sample).toBeNull();
  });


  it('an unavailable selection yields no whole-home sample from the refresh path', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', values: { W: 3_100 } },
        { type: 'cumulative', id: 'other', values: { W: 900 } },
      ],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
    );

    await expect(transport.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } })).resolves.toBeNull();
  });

  it('an empty report yields NO sample, so no identity can publish at all', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }) },
    );

    const sample = await transport.refreshSnapshot({
      mainMeterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
    });

    expect(sample).toBeNull();
  });

  // Discard semantics (a rejected/coalesced sample drops identity AND
  // arrangement together) are pinned at the pipeline seam in
  // `powerSamplePipelineIdentity.test.ts` and at the poll source's own
  // generation/source gate — there is no separate arrangement channel left to
  // test here: the field cannot outlive the sample that carries it.
});

describe('fetchLiveMeterItems', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the report meter items', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'han', values: { W: 3200 } },
        { type: 'device', id: 'sub', values: { W: 800 } },
      ],
    });

    await expect(fetchLiveMeterItems()).resolves.toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'sub', type: 'device' },
    ]);
  });

  it('returns an empty list when the REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    await expect(fetchLiveMeterItems()).resolves.toEqual([]);
  });

  it('returns an empty list on API error, never throwing', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));
    await expect(fetchLiveMeterItems()).resolves.toEqual([]);
  });
});
