import type Homey from 'homey';
import {
  createTestDeviceTransport,
  createTestObservedStateDispatcher,
} from '../helpers/deviceTransportHarness';
import {
  extractLiveMeterItems,
  extractLiveMeterPowerWatts,
} from '../../lib/device/managerEnergy';
import { mockHomeyInstance } from '../mocks/homey';
import { fetchLiveGenerationW, fetchLiveMeterItems, fetchLivePowerReport } from '../../lib/device/transport/managerFetch';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import { SNAPSHOT_ABANDON_GRACE_READS } from '../../lib/device/transport/targetedSnapshotMerge';
import type { Logger } from '../../lib/utils/types';
import { PassThrough } from 'node:stream';
import { createRootLogger } from '../../lib/logging/logger';
import { captureLogger } from '../utils/loggerCapture';

// A complete `Logger`: the transport logs through `structuredLog`, which is
// required, so a fixture without one crashes where production cannot.
const makeLogger = (): Logger => ({
  log: vi.fn(),
  error: vi.fn(),
  structuredLog: createRootLogger(new PassThrough()),
});

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
  const logger = makeLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('samples changing watts once a minute but reports meter changes and recovery immediately', async () => {
    vi.useFakeTimers();
    const capture = captureLogger('info', ['devices']);
    const sampleLogger = makeLogger();
    const read = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: 1000 } }],
    });
    const request = { logger: sampleLogger,
      meterDeviceIds: ['meter-main'] };
    try {
      await fetchLivePowerReport(request);
      for (let i = 1; i <= 5; i += 1) {
        vi.advanceTimersByTime(10_000);
        read.mockResolvedValue({ items: [{ type: 'cumulative', id: 'meter-main', values: { W: 1000 + i } }] });
        expect(await fetchLivePowerReport(request)).toMatchObject({ meterPowerW: { 'meter-main': 1000 + i } });
      }
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(1);
      vi.advanceTimersByTime(10_000);
      await fetchLivePowerReport(request);
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(2);

      read.mockResolvedValue({ items: [{ type: 'cumulative', id: 'other-meter', values: { W: 2000 } }] });
      await fetchLivePowerReport({ ...request, meterDeviceIds: ['other-meter'] });
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(3);
      await fetchLivePowerReport(request);
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(4);
      expect(capture.findEvents('energy_live_report_received').at(-1)).toMatchObject({
        meterPowerW: {}, metersRequested: 1,
      });
      read.mockResolvedValue({ items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3000 } }] });
      await fetchLivePowerReport(request);
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(5);
      expect(capture.findEvents('energy_live_report_received').at(-1)).toMatchObject({
        meterPowerW: { 'meter-main': 3000 },
      });
      read.mockResolvedValue(null);
      await fetchLivePowerReport(request);
      expect(sampleLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'energy_live_report_unavailable' }));
      read.mockResolvedValue({ items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3000 } }] });
      await fetchLivePowerReport(request);
      expect(capture.findEvents('energy_live_report_received')).toHaveLength(6);
    } finally {
      capture.restore();
      vi.useRealTimers();
    }
  });

  it('returns both device power and the requested meter from the REST API', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'device', id: 'dev1', values: { W: 800 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterDeviceIds: ['meter-main'],
    });

    expect(result).toMatchObject({
      state: 'measured',
      byDeviceId: { dev1: 800 },
      meterPowerW: { ['meter-main']: 3200 },
      deviceCount: 1,
    });
  });

  it('reads the requested meter, whatever its item type', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterDeviceIds: ['han-meter'],
    });

    expect(result).toMatchObject({
      meterPowerW: { ['han-meter']: 3200 },
      byDeviceId: { 'han-meter': 3200 },
    });
  });

  it('reads no meter when none is requested, keeping the per-device lanes', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterDeviceIds: [],
    });

    // Nothing is guessed: only a requested meter is read, never another meter's watts.
    expect(result).toMatchObject({
      state: 'measured',
      meterPowerW: {},
      byDeviceId: { dev1: 800 },
    });
  });

  it('reads nothing for a requested meter the report does not carry, keeping the rest of the report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      totalGenerated: { W: 600 },
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({
      logger,
      meterDeviceIds: ['gone-meter'],
    });

    expect(result).toMatchObject({
      state: 'measured',
      meterPowerW: {},
      byDeviceId: { dev1: 800 },
      generation: { state: 'measured', watts: 600 },
    });
  });

  it('reports an unavailable read when REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);

    const result = await fetchLivePowerReport({
      logger,
      meterDeviceIds: ['meter-main'],
    });

    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports an unavailable read for a payload that is not a report — never a measurement of nothing', async () => {
    for (const payload of [undefined, '', {}, { items: 'nope' }]) {
      vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(payload);
      const result = await fetchLivePowerReport({
        logger,
        meterDeviceIds: ['meter-main'],
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
      meterDeviceIds: ['meter-main'],
    });

    expect(result).toEqual({ state: 'unavailable' });
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('DeviceTransport.readMeters', () => {
  const logger = makeLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The transport reads meters, not homes: every requested meter that answered,
  // and the report's generation, with no notion of which one is Main.
  it('reads every requested meter from one report, with its generation', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
        { type: 'cumulative', id: 'meter-area', values: { W: 1_200 } },
        { type: 'cumulative', id: 'unrequested', values: { W: 9_999 } },
      ],
      totalGenerated: { W: 400 },
    });
    const setGenerationW = vi.fn();
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
      undefined,
      { observedStateDispatcher: createTestObservedStateDispatcher({ setGenerationW }) },
    );

    await expect(transport.readMeters(['meter-main', 'meter-area', 'gone'])).resolves.toEqual({
      meterPowerW: { 'meter-main': 3_000, 'meter-area': 1_200 },
      generationW: 400,
    });
    expect(setGenerationW).toHaveBeenCalledWith(400, expect.any(Number));
  });

  it('answers null for a failed read, so no home records anything', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.readMeters(['meter-main'])).resolves.toBeNull();
  });
});

describe('meter readings on a snapshot refresh', () => {
  const logger = makeLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Drives the REAL `DeviceTransport.refreshSnapshot` pipeline: these readings
  // are what `AppSnapshotHelpers` builds Main's sample from (`readMeterSample`).
  it('returns the requested meters\' readings', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'm-area', values: { W: 4_200 } }],
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.refreshSnapshot({ meterDeviceIds: ['m-area'] })).resolves.toEqual({
      meterPowerW: { 'm-area': 4_200 },
    });
  });

  it('reads nothing for an id-less item: no request can name it', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', values: { W: 4_200 } }],
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.refreshSnapshot({ meterDeviceIds: ['meter-main'] })).resolves.toEqual({ meterPowerW: {} });
  });

  it('reads no meter when none is requested', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [{ type: 'cumulative', id: 'm-area', values: { W: 4_200 } }],
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.refreshSnapshot({ meterDeviceIds: [] })).resolves.toEqual({ meterPowerW: {} });
  });

  it('does NOT read live power on a fast refresh, so there are no readings', async () => {
    const getEnergyLiveReport = vi.spyOn(homeyApi, 'getEnergyLiveReport');
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.refreshSnapshot({ includeLivePower: false, meterDeviceIds: ['meter-main'] }))
      .resolves.toBeNull();
    expect(getEnergyLiveReport).not.toHaveBeenCalled();
  });

  it('reads nothing from an empty report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);

    await expect(transport.refreshSnapshot({ meterDeviceIds: ['meter-main'] })).resolves.toEqual({ meterPowerW: {} });
  });
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

  // No answer must never pass for a meter-less home: the pickers trust an
  // empty list and tell the owner to add a meter.
  it('rejects a report listing no items, which is Homey Energy warming up', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    await expect(fetchLiveMeterItems()).rejects.toThrow('lists no devices yet');
  });

  it('rejects when the REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    await expect(fetchLiveMeterItems()).rejects.toThrow('Homey Energy live report unavailable');
  });

  it('rejects a malformed report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ unexpected: true });
    await expect(fetchLiveMeterItems()).rejects.toThrow('Homey Energy live report unavailable');
  });

  it('rejects on API error', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));
    await expect(fetchLiveMeterItems()).rejects.toThrow('API down');
  });
});

// The silent-meter escalation spends its one fail-closed shed pass only once
// the transport has proven the device list is known. An empty RAW read with no
// previous snapshot commits at once (nothing to clobber), so that commit must
// not count as proof — a real Homey always lists at least its meter, and an
// empty raw list at boot is the transient blip the fetch normalizes into
// success (`feedback_homey_sdk_unreliable`).
describe('hasWarmSnapshot — proof that the SDK listed devices', () => {
  const logger = makeLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays cold on an empty raw read, and warms on a read that listed a device', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const rawDevices = vi.spyOn(homeyApi, 'getRawDevices').mockResolvedValue([]);
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );
    expect(transport.hasWarmSnapshot()).toBe(false);

    await transport.refreshSnapshot({ meterDeviceIds: [] });
    expect(transport.getSnapshot()).toEqual([]);
    expect(transport.hasWarmSnapshot()).toBe(false);

    // The SDK answers with a device that is not even managed: the list is
    // known, so the read counts even though the parsed snapshot stays empty.
    rawDevices.mockResolvedValue([{
      id: 'sensor-1', name: 'Sensor', class: 'sensor', capabilities: [], capabilitiesObj: {},
      available: true, ready: true,
    }]);
    await transport.refreshSnapshot({ meterDeviceIds: [] });
    expect(transport.hasWarmSnapshot()).toBe(true);
  });

  it('goes cold again once an empty-read streak commits []', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const rawDevices = vi.spyOn(homeyApi, 'getRawDevices').mockResolvedValue([{
      id: 'heater-1', name: 'Heater', class: 'heater', capabilities: ['onoff', 'measure_power'],
      capabilitiesObj: { onoff: { value: true }, measure_power: { value: 1800 } }, available: true, ready: true,
    }]);
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {},
    );
    await transport.refreshSnapshot({ meterDeviceIds: [] });
    expect(transport.hasWarmSnapshot()).toBe(true);

    // The flag follows every full COMMIT: transient empties a populated
    // snapshot holds back leave it warm, and the read that finally commits
    // `[]` (past the abandon grace) takes it cold — the list is unknown again.
    rawDevices.mockResolvedValue([]);
    for (let read = 0; read <= SNAPSHOT_ABANDON_GRACE_READS; read += 1) {
      await transport.refreshSnapshot({ meterDeviceIds: [] });
    }
    expect(transport.getSnapshot()).toEqual([]);
    expect(transport.hasWarmSnapshot()).toBe(false);
  });
});
