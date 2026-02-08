import type Homey from 'homey';
import PriceService from '../lib/price/priceService';
import { mockHomeyInstance } from './mocks/homey';
import {
  CONSUMPTION_TAX_STANDARD_EX_VAT,
  ENOVA_FEE_EX_VAT,
  VAT_MULTIPLIER_STANDARD,
} from '../lib/price/priceComponents';
import { getDateKeyInTimeZone, getZonedParts } from '../lib/utils/dateUtils';
import { PRICE_SCHEME } from '../lib/utils/settingsKeys';
import {
  NORGESPRIS_CABIN_MONTHLY_CAP_KWH,
  NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH,
  NORGESPRIS_TARGET_EX_VAT,
} from '../lib/price/norwayPriceDefaults';

const SPOT_PRICE_EX_VAT = 160;
const GRID_TARIFF_EX_VAT = 28;
const NORGESPRIS_TARGET_INC_VAT_STANDARD = NORGESPRIS_TARGET_EX_VAT * VAT_MULTIPLIER_STANDARD;

const buildExpectedBaseTotalIncVat = (): number => (
  (SPOT_PRICE_EX_VAT + GRID_TARIFF_EX_VAT + CONSUMPTION_TAX_STANDARD_EX_VAT + ENOVA_FEE_EX_VAT)
  * VAT_MULTIPLIER_STANDARD
);

const buildExpectedNorgesprisAdjustment = (share: number): number => (
  (NORGESPRIS_TARGET_INC_VAT_STANDARD - SPOT_PRICE_EX_VAT * VAT_MULTIPLIER_STANDARD) * share
);

const createService = (): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  () => {},
  () => {},
  () => {},
);

const setNorwayNorgesprisSettings = (params: {
  now: Date;
  monthUsageKwh: number;
  lastPowerW?: number;
  norwayPriceModel?: 'stromstotte' | 'norgespris';
  tariffGroup?: string;
  countyCode?: string;
  priceArea?: string;
  gridTariffHour?: number;
  spotPrices?: Array<{ startsAt: string; spotPriceExVat: number; currency?: string }>;
  usageSource?: 'dailyTotals' | 'buckets';
  usageBucketIso?: string;
}) => {
  const {
    now,
    monthUsageKwh,
    lastPowerW,
    norwayPriceModel = 'norgespris',
    tariffGroup = 'Husholdning',
    countyCode = '03',
    priceArea = 'NO1',
    gridTariffHour,
    spotPrices = [{
      startsAt: now.toISOString(),
      spotPriceExVat: SPOT_PRICE_EX_VAT,
      currency: 'NOK',
    }],
    usageSource = 'dailyTotals',
    usageBucketIso = now.toISOString(),
  } = params;
  const norwayHour = getZonedParts(now, 'Europe/Oslo').hour;
  const tariffDateKey = getDateKeyInTimeZone(now, 'Europe/Oslo');
  const dailyTotalDateKeyUtc = now.toISOString().slice(0, 10);
  const powerTrackerState: { dailyTotals?: Record<string, number>; buckets?: Record<string, number>; lastPowerW?: number } = {
    lastPowerW,
  };
  if (usageSource === 'dailyTotals') {
    powerTrackerState.dailyTotals = { [dailyTotalDateKeyUtc]: monthUsageKwh };
  } else {
    powerTrackerState.buckets = { [usageBucketIso]: monthUsageKwh };
  }

  mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
  mockHomeyInstance.settings.set('norway_price_model', norwayPriceModel);
  mockHomeyInstance.settings.set('price_area', priceArea);
  mockHomeyInstance.settings.set('nettleie_fylke', countyCode);
  mockHomeyInstance.settings.set('nettleie_tariffgruppe', tariffGroup);
  mockHomeyInstance.settings.set('provider_surcharge', 0);
  mockHomeyInstance.settings.set('electricity_prices', spotPrices);
  mockHomeyInstance.settings.set('nettleie_data', [{
    dateKey: tariffDateKey,
    time: typeof gridTariffHour === 'number' ? gridTariffHour : norwayHour,
    energyFeeExVat: GRID_TARIFF_EX_VAT,
  }]);
  mockHomeyInstance.settings.set('power_tracker_state', powerTrackerState);
};

describe('Norway norgespris pricing', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('applies full norgespris adjustment below household cap', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: 4200,
      lastPowerW: 2000,
      tariffGroup: 'Husholdning',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    const expectedAdjustment = buildExpectedNorgesprisAdjustment(1);
    const expectedTotal = buildExpectedBaseTotalIncVat() + expectedAdjustment;

    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(expectedAdjustment, 2);
    expect(firstPrice.totalPrice).toBeCloseTo(expectedTotal, 2);
    expect((firstPrice.electricitySupport ?? 0)).toBeCloseTo(0, 5);
  });

  it('applies partial norgespris adjustment during household cap transition', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH - 1,
      lastPowerW: 2000, // 2 kWh/h estimate -> 50% remaining eligibility this hour
      tariffGroup: 'Husholdning',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    const expectedAdjustment = buildExpectedNorgesprisAdjustment(0.5);
    const expectedTotal = buildExpectedBaseTotalIncVat() + expectedAdjustment;

    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(expectedAdjustment, 2);
    expect(firstPrice.totalPrice).toBeCloseTo(expectedTotal, 2);
    expect((firstPrice.electricitySupport ?? 0)).toBeCloseTo(0, 5);
  });

  it('uses non-support behavior when household month usage is above cap', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH + 1,
      lastPowerW: 2000,
      tariffGroup: 'Husholdning',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(0, 5);
    expect(firstPrice.totalPrice).toBeCloseTo(buildExpectedBaseTotalIncVat(), 2);
    expect((firstPrice.electricitySupport ?? 0)).toBeCloseTo(0, 5);
  });

  it('uses cabin cap from tariff group instead of configurable cap setting', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    // Legacy settings should be ignored.
    mockHomeyInstance.settings.set('norgespris_target_price', 999);
    mockHomeyInstance.settings.set('norgespris_monthly_cap_kwh', 1);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_CABIN_MONTHLY_CAP_KWH + 1,
      lastPowerW: 2000,
      tariffGroup: 'Hytter og fritidshus',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(0, 5);
    expect(firstPrice.totalPrice).toBeCloseTo(buildExpectedBaseTotalIncVat(), 2);
  });

  it('uses 40 øre/kWh target in no-VAT area (NO4)', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: 0,
      lastPowerW: 2000,
      tariffGroup: 'Husholdning',
      priceArea: 'NO4',
      countyCode: '55',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(NORGESPRIS_TARGET_EX_VAT - SPOT_PRICE_EX_VAT, 2);
  });

  it('omits norgespris adjustment fields when strømstøtte model is active', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: 0,
      lastPowerW: 2000,
      norwayPriceModel: 'stromstotte',
      tariffGroup: 'Husholdning',
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeUndefined();
    expect((firstPrice as any).norgesprisAdjustmentExVat).toBeUndefined();
    expect((firstPrice.electricitySupport ?? 0)).toBeGreaterThan(0);
  });

  it('does not consume current-month cap from past hours', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 15, 0));
    jest.useFakeTimers().setSystemTime(now);
    const previousHour = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
    const currentHour = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH - 1,
      lastPowerW: 2000,
      tariffGroup: 'Husholdning',
      spotPrices: [
        { startsAt: previousHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
        { startsAt: currentHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
    });

    const prices = createService().getCombinedHourlyPrices();
    const current = prices.find((entry) => entry.startsAt === currentHour.toISOString());
    expect(current).toBeDefined();
    expect((current as any).norgesprisAdjustment).toBeCloseTo(buildExpectedNorgesprisAdjustment(0.5), 2);
  });

  it('uses Homey timezone month boundaries for norgespris cap', () => {
    const now = new Date('2026-01-31T23:30:00.000Z'); // Europe/Oslo: 2026-02-01 00:30
    jest.useFakeTimers().setSystemTime(now);
    const boundaryHour = new Date('2026-01-31T23:00:00.000Z'); // Europe/Oslo: 2026-02-01 00:00
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH + 1,
      lastPowerW: 2000,
      usageSource: 'buckets',
      usageBucketIso: boundaryHour.toISOString(),
      spotPrices: [
        { startsAt: boundaryHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
      gridTariffHour: 0,
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(0, 5);
  });

  it('does not overcount UTC daily totals that only partially overlap local month', () => {
    const now = new Date('2026-01-31T23:30:00.000Z'); // Europe/Oslo: 2026-02-01 00:30
    jest.useFakeTimers().setSystemTime(now);
    const boundaryHour = new Date('2026-01-31T23:00:00.000Z'); // Europe/Oslo: 2026-02-01 00:00
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH + 1,
      lastPowerW: 2000,
      spotPrices: [
        { startsAt: boundaryHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
      gridTariffHour: 0,
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect((firstPrice as any).norgesprisAdjustment).toBeCloseTo(buildExpectedNorgesprisAdjustment(1), 2);
  });

  it('uses Homey timezone hour for grid tariff matching', () => {
    const now = new Date('2026-01-31T23:30:00.000Z'); // Europe/Oslo: 00:30 next day
    jest.useFakeTimers().setSystemTime(now);
    const boundaryHour = new Date('2026-01-31T23:00:00.000Z'); // Europe/Oslo: 00:00
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: 0,
      lastPowerW: 2000,
      norwayPriceModel: 'stromstotte',
      spotPrices: [
        { startsAt: boundaryHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
      gridTariffHour: 0,
    });

    const [firstPrice] = createService().getCombinedHourlyPrices();
    expect(firstPrice.gridTariffExVat).toBeCloseTo(GRID_TARIFF_EX_VAT, 5);
  });

  it('resets norgespris cap at month boundary', () => {
    const now = new Date(Date.UTC(2026, 0, 31, 21, 15, 0)); // Europe/Oslo: 22:15 Jan 31
    jest.useFakeTimers().setSystemTime(now);
    const januaryHour = new Date(Date.UTC(2026, 0, 31, 22, 0, 0)); // Europe/Oslo: 23:00 Jan 31
    const februaryHour = new Date(Date.UTC(2026, 0, 31, 23, 0, 0)); // Europe/Oslo: 00:00 Feb 1
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH + 1,
      lastPowerW: 2000,
      usageSource: 'buckets',
      usageBucketIso: januaryHour.toISOString(),
      spotPrices: [
        { startsAt: januaryHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
        { startsAt: februaryHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
    });

    const prices = createService().getCombinedHourlyPrices();
    const january = prices.find((entry) => entry.startsAt === januaryHour.toISOString());
    const february = prices.find((entry) => entry.startsAt === februaryHour.toISOString());
    expect(january).toBeDefined();
    expect(february).toBeDefined();
    expect((january as any).norgesprisAdjustment).toBeCloseTo(0, 5);
    expect((february as any).norgesprisAdjustment).toBeCloseTo(buildExpectedNorgesprisAdjustment(1), 2);
  });

  it('applies cap eligibility in chronological order when spot list is unsorted', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    jest.useFakeTimers().setSystemTime(now);
    const currentHour = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    const nextHour = new Date(Date.UTC(2026, 0, 15, 11, 0, 0));
    setNorwayNorgesprisSettings({
      now,
      monthUsageKwh: NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH - 1,
      lastPowerW: 2000,
      // Intentionally unsorted input.
      spotPrices: [
        { startsAt: nextHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
        { startsAt: currentHour.toISOString(), spotPriceExVat: SPOT_PRICE_EX_VAT, currency: 'NOK' },
      ],
    });

    const prices = createService().getCombinedHourlyPrices();
    expect(prices.map((entry) => entry.startsAt)).toEqual([currentHour.toISOString(), nextHour.toISOString()]);
    const current = prices[0];
    const next = prices[1];
    expect((current as any).norgesprisAdjustment).toBeCloseTo(buildExpectedNorgesprisAdjustment(0.5), 2);
    expect((next as any).norgesprisAdjustment).toBeCloseTo(0, 5);
  });
});
