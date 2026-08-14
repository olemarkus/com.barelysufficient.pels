import type Homey from 'homey';
import {
  extractLiveMeterItems,
  extractLiveMeterPowerWatts,
} from '../../lib/device/managerEnergy';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { mockHomeyInstance } from '../mocks/homey';
import { fetchLiveMeterItems, fetchLivePowerReport } from '../../lib/device/transport/managerFetch';
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

  it('omits an id-less cumulative item (covered by Automatic) and other item types', () => {
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
        { type: 'cumulative', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({ dev1: 800 });
    expect(result.homePowerW).toBe(3200);
    expect(result.deviceCount).toBe(1);
  });

  it('resolves homePowerW from the selected meter, ignoring the cumulative item', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger, meterDeviceId: 'han-meter' });

    expect(result.homePowerW).toBe(3200);
    expect(result.byDeviceId).toEqual({ 'han-meter': 3200 });
  });

  it('classifies unresolved Automatic candidates as ambiguous instead of choosing by order', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger });

    expect(result).toMatchObject({
      homeMeterResolution: 'ambiguous',
      homePowerW: null,
      resolvedHomeMeterDeviceId: null,
      cumulativeItemCount: 2,
    });
  });

  it('uses a preferred Automatic candidate without considering its relative power', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      preferredAutomaticMeterDeviceId: 'meter-main',
    });

    expect(result).toMatchObject({
      homeMeterResolution: 'resolved',
      homePowerW: 3_000,
      resolvedHomeMeterDeviceId: 'meter-main',
      cumulativeItemCount: 2,
    });
  });

  it('resolves homePowerW to null when the selected meter is missing, keeping the rest of the report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      totalGenerated: { W: 600 },
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger, meterDeviceId: 'gone-meter' });

    expect(result.homePowerW).toBeNull();
    expect(result.byDeviceId).toEqual({ dev1: 800 });
    expect(result.generationW).toBe(600);
  });

  it('returns empty results when REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
    expect(result.deviceCount).toBe(0);
  });

  it('returns empty results on API error', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
    expect(result.deviceCount).toBe(0);
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
      providers: {
        // The live provider has recovered by the time the SDK call starts, but
        // the refresh cycle must remain bound to its captured start selection.
        getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
        getAdditionalMeterDeviceIds: () => ['sub-meter'],
      },
    } as unknown as TransportContext;

    const report = await fetchTransportLivePowerReport(ctx, { state: 'unavailable' });

    expect(report.homePowerW).toBeNull();
    expect(report.byDeviceId).toEqual({ 'sub-meter': 1_200 });
    expect(report.additionalMeterPowerW).toEqual({ 'sub-meter': 1_200 });
  });

  it('retains the sole Automatic meter when a second cumulative item appears first', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport')
      .mockResolvedValueOnce({
        items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3_000 } }],
      })
      .mockResolvedValueOnce({
        items: [
          { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
          { type: 'cumulative', id: 'meter-main', values: { W: 3_200 } },
        ],
      });
    const automaticHomeMeterState = { preferredDeviceId: null as string | null };
    const ctx = {
      logger,
      automaticHomeMeterState,
      providers: {
        getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
      },
    } as unknown as TransportContext;

    const first = await pollHomePowerWithMeterFanOut(ctx, () => true);
    automaticHomeMeterState.preferredDeviceId = first?.automaticHomeMeterDeviceId ?? null;
    const reordered = await pollHomePowerWithMeterFanOut(ctx, () => true);

    expect(first).toMatchObject({
      powerW: 3_000,
      resolvedHomeMeterDeviceId: 'meter-main',
    });
    expect(automaticHomeMeterState.preferredDeviceId).toBe('meter-main');
    expect(reordered).toMatchObject({
      powerW: 3_200,
      resolvedHomeMeterDeviceId: 'meter-main',
    });
  });

  it('returns an Automatic candidate without retaining it before admission', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'meter-stale', values: { W: 3_000 } }],
    });
    const automaticHomeMeterState = { preferredDeviceId: null as string | null };
    const ctx = {
      logger,
      automaticHomeMeterState,
      providers: {
        getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
      },
    } as unknown as TransportContext;

    const sample = await pollHomePowerWithMeterFanOut(ctx, () => false);

    expect(automaticHomeMeterState.preferredDeviceId).toBeNull();
    expect(sample?.automaticHomeMeterDeviceId).toBe('meter-stale');
  });

  it('fans out area readings when Automatic Main is ambiguous', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
        { type: 'cumulative', id: 'meter-area', values: { W: 1_200 } },
      ],
    });
    const onAdditionalMeterReadings = vi.fn();
    const ctx = {
      logger,
      automaticHomeMeterState: { preferredDeviceId: null },
      providers: {
        getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
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

  // Drives the REAL `DeviceTransport.refreshSnapshot()` pipeline, not the
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
      {},
    );

    const sample = await transport.refreshSnapshot();

    expect(sample).toEqual({
      powerW: 4_200,
      resolvedHomeMeterDeviceId: 'm-area',
      homeMeterArrangement: 'identified',
    });
  });

  it('carries a NULL identity when the reading has no attributable id', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', values: { W: 4_200 } }],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );

    const sample = await transport.refreshSnapshot();

    // The watts are real; only their ownership is unprovable. `null` must ride
    // along so the ingest can evaluate the fence episode without claiming
    // proof of non-collision.
    expect(sample).toEqual({ powerW: 4_200, resolvedHomeMeterDeviceId: null, homeMeterArrangement: 'idless_aggregate_only' });
  });

  it('carries the identity on the poll path sample too', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'm-area', values: { W: 4_200 } }],
    });
    const ctx = {
      logger,
      automaticHomeMeterState: { preferredDeviceId: null },
      providers: {
        getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: null }),
      },
    } as unknown as TransportContext;

    const sample = await pollHomePowerWithMeterFanOut(ctx, () => true);

    // The candidate rides to the poll source's admitted-ingest boundary. A
    // stale, wrong-source, or superseded sample therefore cannot retain it.
    expect(sample).toEqual({
      powerW: 4_200,
      resolvedHomeMeterDeviceId: 'm-area',
      homeMeterArrangement: 'identified',
      automaticHomeMeterDeviceId: 'm-area',
    });
  });

  it('does NOT read live power on a fast refresh, so no sample and no identity exist', async () => {
    const getEnergyLiveReport = vi.spyOn(homeyApi, 'getEnergyLiveReport');
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );

    const sample = await transport.refreshSnapshot({ includeLivePower: false });

    expect(getEnergyLiveReport).not.toHaveBeenCalled();
    expect(sample).toBeNull();
  });

  // The arrangement observation RIDES THE SAMPLE (same admitted ingest as the
  // identity): what one read proves about whether the whole-home meter can be
  // NAMED at all. An empty report yields no sample, so it can publish nothing
  // — structurally the `unproven`-never-overwrites semantics.
  it.each([
    [
      'a sole id-less cumulative item proves the aggregate is unnameable',
      [{ type: 'cumulative', values: { W: 3_100 } }],
      'idless_aggregate_only',
    ],
    [
      'an id-bearing whole-home item proves it can be named',
      [{ type: 'cumulative', id: 'han', values: { W: 3_100 } }],
      'identified',
    ],
    [
      // Latching `idless_aggregate_only` here would make the area save refuse
      // with "not supported" while the Whole-home meter picker offers this very
      // device meter — naming it is the remedy, so the read proves neither.
      'an id-less aggregate beside a selectable id-bearing meter proves neither',
      [
        { type: 'cumulative', values: { W: 3_100 } },
        { type: 'device', id: 'garage-meter', values: { W: 900 } },
      ],
      'unproven',
    ],
  ])('the sample carries the arrangement: %s', async (_label, items, expected) => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );

    const sample = await transport.refreshSnapshot();

    expect(sample?.homeMeterArrangement).toBe(expected);
  });

  it('several cumulative items produce no Automatic sample without a proven preference', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', values: { W: 3_100 } },
        { type: 'cumulative', id: 'other', values: { W: 900 } },
      ],
    });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );

    await expect(transport.refreshSnapshot()).resolves.toBeNull();
  });

  it('an empty report yields NO sample, so no arrangement can publish at all', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    const transport = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );

    const sample = await transport.refreshSnapshot();

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
