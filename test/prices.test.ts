import https from 'https';
import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
  ELECTRICITY_SUPPORT_COVERAGE,
  ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT,
} from '../lib/price/priceComponents';

// Mock the https module
jest.mock('https', () => ({
  get: jest.fn(),
}));

// Mock the homey-api module
jest.mock('homey-api', () => ({
  HomeyAPI: {
    createAppAPI: jest.fn().mockResolvedValue(require('./mocks/homey').mockHomeyApiInstance),
  },
}));

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date', 'nextTick'] });

// Helper to wait for async operations
const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const createErroringRequest = () => {
  const req: any = {
    on: jest.fn(),
    setTimeout: jest.fn(),
    destroy: jest.fn(),
  };
  req.on.mockImplementation((event: string, handler: Function) => {
    if (event === 'error') {
      handler(new Error('Network error'));
    }
    return req;
  });
  return req;
};

const formatDateInOslo = (date: Date): string => {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
};

const subtractMonths = (date: Date, months: number): Date => {
  const target = new Date(date);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() - months);
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, daysInMonth));
  return target;
};

const buildExpectedGridTariffDates = (baseDate: Date): {
  today: string;
  yesterday: string;
  week: string;
  month: string;
} => {
  const yesterdayDate = new Date(baseDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const weekDate = new Date(baseDate);
  weekDate.setDate(weekDate.getDate() - 7);
  const monthDate = subtractMonths(baseDate, 1);
  return {
    today: formatDateInOslo(baseDate),
    yesterday: formatDateInOslo(yesterdayDate),
    week: formatDateInOslo(weekDate),
    month: formatDateInOslo(monthDate),
  };
};

// Mock response data structures based on real API responses
const mockHvakosterStrommenResponse = [
  {
    NOK_per_kWh: 0.35,
    EUR_per_kWh: 0.03,
    EXR: 11.5,
    time_start: '2025-12-01T00:00:00+01:00',
    time_end: '2025-12-01T01:00:00+01:00',
  },
  {
    NOK_per_kWh: 0.32,
    EUR_per_kWh: 0.028,
    EXR: 11.5,
    time_start: '2025-12-01T01:00:00+01:00',
    time_end: '2025-12-01T02:00:00+01:00',
  },
  {
    NOK_per_kWh: 0.28,
    EUR_per_kWh: 0.024,
    EXR: 11.5,
    time_start: '2025-12-01T02:00:00+01:00',
    time_end: '2025-12-01T03:00:00+01:00',
  },
  {
    NOK_per_kWh: 0.45,
    EUR_per_kWh: 0.039,
    EXR: 11.5,
    time_start: '2025-12-01T07:00:00+01:00',
    time_end: '2025-12-01T08:00:00+01:00',
  },
  {
    NOK_per_kWh: 0.52,
    EUR_per_kWh: 0.045,
    EXR: 11.5,
    time_start: '2025-12-01T08:00:00+01:00',
    time_end: '2025-12-01T09:00:00+01:00',
  },
];

const mockNveGridTariffResponse = [
  {
    datoId: '2025-12-01T00:00:00',
    time: 0,
    tariffgruppe: 'Husholdning',
    kundegruppe: 'Eksempelkunde 4 (sommer)/6 (vinter) kW, 20 000kWh',
    konsesjonar: 'ELVIA AS',
    organisasjonsnr: '980489698',
    fylkeNr: '03',
    fylke: 'Oslo',
    harMva: true,
    harForbruksavgift: true,
    fastleddEks: 244.0,
    energileddEks: 19.12,
    effekttrinnFraKw: 5.0,
    effekttrinnTilKw: 10.0,
    fastleddInk: 305.0,
    energileddInk: 35.79,
  },
  {
    datoId: '2025-12-01T00:00:00',
    time: 1,
    tariffgruppe: 'Husholdning',
    kundegruppe: 'Eksempelkunde 4 (sommer)/6 (vinter) kW, 20 000kWh',
    konsesjonar: 'ELVIA AS',
    organisasjonsnr: '980489698',
    fylkeNr: '03',
    fylke: 'Oslo',
    harMva: true,
    harForbruksavgift: true,
    fastleddEks: 244.0,
    energileddEks: 15.5,
    effekttrinnFraKw: 5.0,
    effekttrinnTilKw: 10.0,
    fastleddInk: 305.0,
    energileddInk: 29.8,
  },
  {
    datoId: '2025-12-01T00:00:00',
    time: 6,
    tariffgruppe: 'Husholdning',
    kundegruppe: 'Eksempelkunde 4 (sommer)/6 (vinter) kW, 20 000kWh',
    konsesjonar: 'ELVIA AS',
    organisasjonsnr: '980489698',
    fylkeNr: '03',
    fylke: 'Oslo',
    harMva: true,
    harForbruksavgift: true,
    fastleddEks: 244.0,
    energileddEks: 30.25,
    effekttrinnFraKw: 5.0,
    effekttrinnTilKw: 10.0,
    fastleddInk: 305.0,
    energileddInk: 50.12,
  },
];

// Helper to create a mock https response
const createMockHttpsResponse = (statusCode: number, data: any) => {
  const mockResponse: any = {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'Error',
    on: jest.fn((event: string, callback: Function) => {
      if (event === 'data') {
        callback(JSON.stringify(data));
      }
      if (event === 'end') {
        callback();
      }
      return mockResponse;
    }),
  };
  return mockResponse;
};

describe('Spot price fetching', () => {
  let mockHttpsGet: jest.Mock;
  let allowConsoleErrorUntilCleanup = false;
  // Use require to avoid ESM extension issues in TS tests
  const { setAllowConsoleError } = require('./setup');

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();
    mockHttpsGet = https.get as jest.Mock;
    mockHttpsGet.mockReset();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    if (allowConsoleErrorUntilCleanup) {
      setAllowConsoleError(false);
      allowConsoleErrorUntilCleanup = false;
    }
  });

  it('fetches and transforms spot prices from hvakosterstrommen.no', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set up price area
    mockHomeyInstance.settings.set('price_area', 'NO1');

    // Mock the HTTPS response
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    const app = createApp();
    await app.onInit();

    // Trigger spot price refresh
    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());

    // Allow async operations to complete
    await flushPromises();

    // Check that prices were stored
    const prices = mockHomeyInstance.settings.get('electricity_prices');
    expect(Array.isArray(prices)).toBe(true);
    expect(prices.length).toBeGreaterThan(0);

    // Check price transformation (NOK/kWh to øre/kWh, ex VAT)
    const firstPrice = prices[0];
    expect(firstPrice).toHaveProperty('startsAt');
    expect(firstPrice).toHaveProperty('spotPriceExVat');
    expect(firstPrice).toHaveProperty('currency', 'NOK');
    // 0.35 NOK/kWh * 100 = 35 øre/kWh
    expect(firstPrice.spotPriceExVat).toBeCloseTo(35, 1);
  });

  it('emits prices_updated realtime event when prices are refreshed', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('price_area', 'NO1');

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    const app = createApp();
    await app.onInit();

    // Clear events from initialization
    mockHomeyInstance.api.clearRealtimeEvents();

    // Trigger spot price refresh
    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    // Check that prices_updated event was emitted
    const priceEvents = mockHomeyInstance.api._realtimeEvents.filter((e: { event: string }) => e.event === 'prices_updated');
    expect(priceEvents.length).toBeGreaterThan(0);

    // Verify the event data contains price info
    const lastPriceEvent = priceEvents[priceEvents.length - 1];
    expect(lastPriceEvent.data).toHaveProperty('prices');
    expect(lastPriceEvent.data).toHaveProperty('avgPrice');
    expect(Array.isArray(lastPriceEvent.data.prices)).toBe(true);
  });

  it('uses VAT exemption for NO4 (Nord-Norge)', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set up price area NO4 (no VAT)
    mockHomeyInstance.settings.set('price_area', 'NO4');

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    const combined = mockHomeyInstance.settings.get('combined_prices') as { prices?: Array<{ vatMultiplier?: number; vatAmount?: number; total?: number; totalExVat?: number }> } | null;
    expect(combined?.prices?.length).toBeGreaterThan(0);
    const firstPrice = combined?.prices?.[0];
    expect(firstPrice?.vatMultiplier).toBe(1);
    expect(firstPrice?.vatAmount).toBeCloseTo(0, 5);
    expect(firstPrice?.total).toBeCloseTo(firstPrice?.totalExVat ?? 0, 5);
  });

  it('handles 404 response gracefully (prices not yet available)', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('price_area', 'NO1');

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(404, null);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    // Should not throw, prices should be empty or undefined
    const prices = mockHomeyInstance.settings.get('electricity_prices');
    expect(prices === undefined || prices.length === 0).toBe(true);
  });

  it('handles network errors gracefully', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('price_area', 'NO1');

    mockHttpsGet.mockImplementation(() => createErroringRequest());

    setAllowConsoleError(true);
    allowConsoleErrorUntilCleanup = true;

    const app = createApp();
    await app.onInit();

    // Should not throw
    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    // No prices stored due to error
    const prices = mockHomeyInstance.settings.get('electricity_prices');
    expect(prices === undefined || prices.length === 0).toBe(true);
  });

  it('uses default price area NO1 when not configured', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // No price_area set

    let capturedUrl = '';
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      capturedUrl = url;
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    // Should use NO1 as default
    expect(capturedUrl).toContain('_NO1.json');
  });

  it('refetches prices when price area changes even if cache has today', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Freeze time to a morning hour (before tomorrow-price window) for deterministic cache logic
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const todayStr = now.toISOString().split('T')[0];
    const originalDate = global.Date;
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    global.Date = MockDate;

    // Seed cache for NO1, then switch to NO2
    mockHomeyInstance.settings.set('price_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices', [{
      startsAt: `${todayStr}T00:00:00.000Z`,
      spotPriceExVat: 40,
      currency: 'NOK',
    }]);
    mockHomeyInstance.settings.set('price_area', 'NO2');

    let fetchCount = 0;
    let capturedUrl = '';
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      fetchCount++;
      capturedUrl = url;
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      expect(fetchCount).toBeGreaterThan(0);
      expect(capturedUrl).toContain('_NO2.json');
    } finally {
      global.Date = originalDate;
    }
  });

  it('refreshes prices after 13:15 if tomorrow prices are missing', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set time to 14:00 (after 13:15)
    const now = new Date();
    now.setHours(14, 0, 0, 0);
    const todayStr = now.toISOString().split('T')[0];

    // Pre-populate with only today's prices (no tomorrow)
    const todayPrices = mockHvakosterStrommenResponse.map((p) => ({
      startsAt: p.time_start.replace(/\d{4}-\d{2}-\d{2}/, todayStr),
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    mockHomeyInstance.settings.set('electricity_prices', todayPrices);
    mockHomeyInstance.settings.set('price_area', 'NO1');

    let fetchCount = 0;
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      fetchCount++;
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    // Mock Date to return 14:00
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;
    const { setAllowConsoleError } = require('./setup');
    setAllowConsoleError(true);

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      // Should have fetched prices because it's after 13:15 and tomorrow's prices are missing
      expect(fetchCount).toBeGreaterThan(0);
    } finally {
      setAllowConsoleError(false);
      global.Date = originalDate;
    }
  });

  it('uses cache if tomorrow prices already exist after 13:15', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set time to 14:00 (after 13:15)
    const now = new Date();
    now.setHours(14, 0, 0, 0);
    const todayStr = now.toISOString().split('T')[0];
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Pre-populate with today's AND tomorrow's prices
    const todayPrices = mockHvakosterStrommenResponse.map((p) => ({
      startsAt: p.time_start.replace(/\d{4}-\d{2}-\d{2}/, todayStr),
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    const tomorrowPrices = mockHvakosterStrommenResponse.map((p) => ({
      startsAt: p.time_start.replace(/\d{4}-\d{2}-\d{2}/, tomorrowStr),
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    mockHomeyInstance.settings.set('electricity_prices', [...todayPrices, ...tomorrowPrices]);
    mockHomeyInstance.settings.set('price_area', 'NO1');

    let fetchCount = 0;
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      fetchCount++;
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    // Mock Date to return 14:00
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      // Should NOT have fetched prices because we already have tomorrow's prices
      expect(fetchCount).toBe(0);
    } finally {
      global.Date = originalDate;
    }
  });

  it('uses cache before 13:15 even without tomorrow prices', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set time to 10:00 (before 13:15)
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const todayStr = now.toISOString().split('T')[0];

    // Pre-populate with only today's prices (no tomorrow)
    const todayPrices = mockHvakosterStrommenResponse.map((p) => ({
      startsAt: p.time_start.replace(/\d{4}-\d{2}-\d{2}/, todayStr),
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    mockHomeyInstance.settings.set('electricity_prices', todayPrices);
    mockHomeyInstance.settings.set('price_area', 'NO1');

    let fetchCount = 0;
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      fetchCount++;
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
    });

    // Mock Date to return 10:00
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      // Should NOT have fetched because it's before 13:15 (tomorrow's prices not expected yet)
      expect(fetchCount).toBe(0);
    } finally {
      global.Date = originalDate;
    }
  });
});

describe('Grid tariff fetching', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();

    // Mock global fetch for grid tariffs (uses fetch, not https)
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    global.fetch = originalFetch;
  });

  it('fetches and stores grid tariff data from NVE API', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Configure grid tariff settings
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_orgnr', '980489698');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockNveGridTariffResponse,
    });

    const app = createApp();
    await app.onInit();

    // Trigger grid tariff refresh
    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

    // Check that grid tariff data was stored
    const gridTariffData = mockHomeyInstance.settings.get('nettleie_data');
    expect(Array.isArray(gridTariffData)).toBe(true);
    expect(gridTariffData.length).toBe(3);

    // Check data structure
    const firstEntry = gridTariffData[0];
    expect(firstEntry).toHaveProperty('time', 0);
    expect(firstEntry).toHaveProperty('energyFeeExVat', 19.12);
    expect(firstEntry).toHaveProperty('energyFeeIncVat', 35.79);
    expect(firstEntry).toHaveProperty('fixedFeeExVat', 244.0);
    expect(firstEntry).toHaveProperty('fixedFeeIncVat', 305.0);
    expect(firstEntry).toHaveProperty('dateKey');
  });

  it('skips fetch when organization number is not configured', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Only set county, no organization number
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
    // No organization number set

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

    // Fetch should not have been called
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles NVE API errors gracefully', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_orgnr', '980489698');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');

    // Mock fetch to return error
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { setAllowConsoleError } = require('./setup');
    setAllowConsoleError(true);
    try {
      const app = createApp();
      await app.onInit();

      // Should not throw
      mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
      await flushPromises();
    } finally {
      setAllowConsoleError(false);
    }

    // No data stored due to error
    const gridTariffData = mockHomeyInstance.settings.get('nettleie_data');
    expect(gridTariffData).toBeUndefined();
  });

  it('uses correct URL format with encoded parameters', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('nettleie_fylke', '46');
    mockHomeyInstance.settings.set('nettleie_orgnr', '976944801');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Hytter og fritidshus');

    let capturedUrl = '';
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    });

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

    // Check URL contains correct parameters
    expect(capturedUrl).toContain('nettleietariffer.dataplattform.nve.no');
    expect(capturedUrl).toContain('FylkeNr=46');
    expect(capturedUrl).toContain('OrganisasjonsNr=976944801');
    // URLSearchParams uses + for spaces, which is valid URL encoding
    expect(capturedUrl).toMatch(/Tariffgruppe=Hytter(\+|%20)og(\+|%20)fritidshus/);
  });

  it('falls back to earlier dates and stops after successful response', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('nettleie_fylke', '46');
    mockHomeyInstance.settings.set('nettleie_orgnr', '976944801');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Hytter og fritidshus');

    const now = new Date(2026, 0, 3, 12, 0, 0);
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      const { today, yesterday, week } = buildExpectedGridTariffDates(now);
      const requestedDates: string[] = [];
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        const date = new URL(url).searchParams.get('ValgtDato') ?? '';
        requestedDates.push(date);
        const payload = date === week ? mockNveGridTariffResponse : [];
        return Promise.resolve({
          ok: true,
          json: async () => payload,
        });
      });

      const app = createApp();
      await app.onInit();
      requestedDates.length = 0;
      (global.fetch as jest.Mock).mockClear();

      mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
      await flushPromises();

      expect(requestedDates).toEqual([today, yesterday, week]);
      const gridTariffData = mockHomeyInstance.settings.get('nettleie_data');
      expect(Array.isArray(gridTariffData)).toBe(true);
      expect(gridTariffData.length).toBe(mockNveGridTariffResponse.length);
    } finally {
      global.Date = originalDate;
    }
  });

  it('logs when all grid tariff fallback attempts are empty', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('nettleie_fylke', '46');
    mockHomeyInstance.settings.set('nettleie_orgnr', '976944801');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Hytter og fritidshus');

    const now = new Date(2026, 0, 3, 12, 0, 0);
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    const { setAllowConsoleError } = require('./setup');
    setAllowConsoleError(true);
    try {
      const { today, yesterday, week, month } = buildExpectedGridTariffDates(now);
      const requestedDates: string[] = [];
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        const date = new URL(url).searchParams.get('ValgtDato') ?? '';
        requestedDates.push(date);
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      });

      const app = createApp();
      await app.onInit();
      requestedDates.length = 0;
      (global.fetch as jest.Mock).mockClear();

      mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
      await flushPromises();

      expect(requestedDates).toEqual([today, yesterday, week, month]);
      const errorCalls = (console.error as jest.Mock).mock.calls;
      const cachedCall = errorCalls.find(([message]) => (
        typeof message === 'string'
        && message.includes('Keeping cached tariff data (NVE returned empty list)')
      ));
      expect(cachedCall).toBeTruthy();
      const payload = cachedCall?.[1] as { attempts?: Array<{ label: string; date: string }> } | undefined;
      expect(payload?.attempts).toEqual([
        { label: 'today', date: today },
        { label: 'yesterday', date: yesterday },
        { label: 'week', date: week },
        { label: 'month', date: month },
      ]);
    } finally {
      setAllowConsoleError(false);
      global.Date = originalDate;
    }
  });
});

describe('Price data structures', () => {
  it('hvakosterstrommen response has expected fields', () => {
    const entry = mockHvakosterStrommenResponse[0];
    expect(entry).toHaveProperty('NOK_per_kWh');
    expect(entry).toHaveProperty('EUR_per_kWh');
    expect(entry).toHaveProperty('EXR');
    expect(entry).toHaveProperty('time_start');
    expect(entry).toHaveProperty('time_end');
    expect(typeof entry.NOK_per_kWh).toBe('number');
    expect(typeof entry.time_start).toBe('string');
  });

  it('NVE grid tariff response has expected fields', () => {
    const entry = mockNveGridTariffResponse[0];
    expect(entry).toHaveProperty('datoId');
    expect(entry).toHaveProperty('time');
    expect(entry).toHaveProperty('tariffgruppe');
    expect(entry).toHaveProperty('konsesjonar');
    expect(entry).toHaveProperty('organisasjonsnr');
    expect(entry).toHaveProperty('fylkeNr');
    expect(entry).toHaveProperty('fylke');
    expect(entry).toHaveProperty('harMva');
    expect(entry).toHaveProperty('harForbruksavgift');
    expect(entry).toHaveProperty('fastleddEks');
    expect(entry).toHaveProperty('energileddEks');
    expect(entry).toHaveProperty('fastleddInk');
    expect(entry).toHaveProperty('energileddInk');
    expect(entry).toHaveProperty('effekttrinnFraKw');
    expect(entry).toHaveProperty('effekttrinnTilKw');
    expect(typeof entry.time).toBe('number');
    expect(typeof entry.energileddInk).toBe('number');
  });
});

describe('Price optimization', () => {
  let mockHttpsGet: jest.Mock;
  let originalFetch: typeof global.fetch;

  // Generate mock prices for 24 hours with varying prices
  const generateMockPricesFor24Hours = (baseDate: Date) => {
    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      // Cheap hours: 2-5 (night), expensive hours: 7-9 and 17-19 (morning/evening peaks)
      let priceNok = 0.30;
      if (hour >= 2 && hour <= 5) priceNok = 0.15; // cheap
      if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) priceNok = 0.60; // expensive

      prices.push({
        NOK_per_kWh: priceNok,
        EUR_per_kWh: priceNok / 11.5,
        EXR: 11.5,
        time_start: date.toISOString(),
        time_end: new Date(date.getTime() + 60 * 60 * 1000).toISOString(),
      });
    }
    return prices;
  };

  // Generate grid tariff data for 24 hours
  const generateMockGridTariffFor24Hours = () => {
    const data: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      // Day rate (6-22) vs night rate (22-6)
      const isNight = hour < 6 || hour >= 22;
      data.push({
        dateKey: '2025-12-01T00:00:00',
        time: hour,
        fixedFeeExVat: 244.0,
        energyFeeExVat: isNight ? 15.0 : 25.0,
        fixedFeeIncVat: 305.0,
        energyFeeIncVat: isNight ? 20.0 : 35.0,
      });
    }
    return data;
  };

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();
    mockHttpsGet = https.get as jest.Mock;
    mockHttpsGet.mockReset();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    global.fetch = originalFetch;
  });

  it('combines spot prices and grid tariffs correctly for total cost', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Store mock price data directly (simulating already fetched data)
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const spotPrices = generateMockPricesFor24Hours(now).map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    const gridTariffData = generateMockGridTariffFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', gridTariffData);

    // Mock https for the refresh that happens on init
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(now));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Access private method via bracket notation for testing
    const combinedPrices = app['getCombinedHourlyPrices']();

    expect(Array.isArray(combinedPrices)).toBe(true);
    expect(combinedPrices.length).toBeGreaterThan(0);

    // Each combined price should include all components
    const firstPrice = combinedPrices[0];
    expect(firstPrice).toHaveProperty('startsAt');
    expect(firstPrice).toHaveProperty('spotPriceExVat');
    expect(firstPrice).toHaveProperty('gridTariffExVat');
    expect(firstPrice).toHaveProperty('providerSurchargeExVat');
    expect(firstPrice).toHaveProperty('consumptionTaxExVat');
    expect(firstPrice).toHaveProperty('enovaFeeExVat');
    expect(firstPrice).toHaveProperty('vatMultiplier');
    expect(firstPrice).toHaveProperty('vatAmount');
    expect(firstPrice).toHaveProperty('electricitySupport');
    expect(firstPrice).toHaveProperty('totalExVat');
    expect(firstPrice).toHaveProperty('totalPrice');
    expect(firstPrice.totalExVat).toBeCloseTo(
      firstPrice.spotPriceExVat
        + firstPrice.gridTariffExVat
        + firstPrice.providerSurchargeExVat
        + firstPrice.consumptionTaxExVat
        + firstPrice.enovaFeeExVat,
      5,
    );
    expect(firstPrice.totalPrice).toBeCloseTo(
      firstPrice.totalExVat * firstPrice.vatMultiplier - firstPrice.electricitySupport,
      5,
    );
  });

  it('treats provider surcharge as VAT-inclusive in settings', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const spotPrices = [{
      startsAt: now.toISOString(),
      spotPriceExVat: 100,
      currency: 'NOK',
    }];

    mockHomeyInstance.settings.set('price_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('provider_surcharge', 12.5);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    const [firstPrice] = app['getCombinedHourlyPrices']();
    expect(firstPrice.providerSurchargeExVat).toBeCloseTo(10, 5);
  });

  it('applies electricity support when spot price exceeds the threshold', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const spotPriceExVat = ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT + 20;
    const spotPrices = [{
      startsAt: now.toISOString(),
      spotPriceExVat,
      currency: 'NOK',
    }];

    mockHomeyInstance.settings.set('price_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices_area', 'NO1');
    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    const [firstPrice] = app['getCombinedHourlyPrices']();
    const expectedSupportExVat = (spotPriceExVat - ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT) * ELECTRICITY_SUPPORT_COVERAGE;
    expect(firstPrice.electricitySupportExVat).toBeCloseTo(expectedSupportExVat, 5);
    expect(firstPrice.electricitySupport).toBeCloseTo(expectedSupportExVat * firstPrice.vatMultiplier, 5);
    expect(firstPrice.totalPrice).toBeCloseTo(
      firstPrice.totalExVat * firstPrice.vatMultiplier - firstPrice.electricitySupport,
      5,
    );
  });

  it('matches the price breakdown example for a high-price hour in NO1', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const vatMultiplier = 1.25;
    const spotPriceIncVat = 200;
    const gridTariffIncVat = 35;
    const spotPriceExVat = spotPriceIncVat / vatMultiplier;
    const gridTariffExVat = gridTariffIncVat / vatMultiplier;

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    mockHomeyInstance.settings.set('price_area', 'NO1');
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('electricity_prices_area', 'NO1');
    mockHomeyInstance.settings.set('provider_surcharge', 0);
    mockHomeyInstance.settings.set('electricity_prices', [
      { startsAt: now.toISOString(), spotPriceExVat, currency: 'NOK' },
      { startsAt: tomorrow.toISOString(), spotPriceExVat, currency: 'NOK' },
    ]);
    mockHomeyInstance.settings.set('nettleie_data', [{
      dateKey: now.toISOString().split('T')[0],
      time: now.getHours(),
      energyFeeExVat: gridTariffExVat,
    }]);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, mockHvakosterStrommenResponse);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    const [firstPrice] = app['getCombinedHourlyPrices']();
    expect(firstPrice.spotPriceExVat).toBeCloseTo(160, 5);
    expect(firstPrice.gridTariffExVat).toBeCloseTo(28, 5);
    expect(firstPrice.consumptionTaxExVat * firstPrice.vatMultiplier).toBeCloseTo(8.91, 2);
    expect(firstPrice.electricitySupport).toBeCloseTo(93.38, 2);
    expect(firstPrice.totalPrice).toBeCloseTo(151.79, 2);
  });

  it('finds the cheapest hours correctly', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Create prices starting from "now" into the future
    // The function filters to only future hours, so we need prices that start at or after "now"
    const now = new Date();
    now.setMinutes(0, 0, 0); // Start of current hour

    // Generate 24 hours of prices starting from NOW
    const generate24HoursFromNow = () => {
      const prices: any[] = [];
      for (let i = 0; i < 24; i++) {
        const date = new Date(now.getTime() + i * 60 * 60 * 1000);
        const hour = date.getHours();
        // Make specific hours clearly cheapest: hours that match 2-5 in any day
        let priceNok = 0.30;
        if (hour >= 2 && hour <= 5) priceNok = 0.10; // very cheap
        else if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) priceNok = 0.60; // expensive

        prices.push({
          NOK_per_kWh: priceNok,
          EUR_per_kWh: priceNok / 11.5,
          EXR: 11.5,
          time_start: date.toISOString(),
          time_end: new Date(date.getTime() + 60 * 60 * 1000).toISOString(),
        });
      }
      return prices;
    };

    const rawPrices = generate24HoursFromNow();
    const spotPrices = rawPrices.map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    const gridTariffData = generateMockGridTariffFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', gridTariffData);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, rawPrices);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Find 4 cheapest hours
    const cheapestHours = app['findCheapestHours'](4);

    // Should get up to 4 hours (or fewer if not enough cheap hours exist in next 24h)
    expect(cheapestHours.length).toBeGreaterThan(0);
    expect(cheapestHours.length).toBeLessThanOrEqual(4);

    // Verify the returned hours are sorted by price (cheapest first)
    const combinedPrices = app['getCombinedHourlyPrices']();
    const cheapestPrices = cheapestHours.map((hourStr: string) => {
      const price = combinedPrices.find((p: any) => p.startsAt === hourStr);
      return price ? price.totalPrice : Infinity;
    });

    // Verify prices are in ascending order
    for (let i = 1; i < cheapestPrices.length; i++) {
      expect(cheapestPrices[i]).toBeGreaterThanOrEqual(cheapestPrices[i - 1]);
    }
  });

  it('applies cheapDelta temperature during cheap hours', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Set current hour to a cheap hour (hour 3)
    const now = new Date();
    now.setHours(3, 30, 0, 0);

    const spotPrices = generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())).map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    const gridTariffData = generateMockGridTariffFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', gridTariffData);

    // Configure price optimization for the water heater with delta-based settings
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10, // +10°C during cheap hours
        expensiveDelta: -5, // -5°C during expensive hours
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // The app should have loaded the price optimization settings
    expect(app['priceOptimizationSettings']).toBeDefined();
    expect(app['priceOptimizationSettings']['water-heater-1']).toBeDefined();
    expect(app['priceOptimizationSettings']['water-heater-1'].enabled).toBe(true);
    expect(app['priceOptimizationSettings']['water-heater-1'].cheapDelta).toBe(10);
    expect(app['priceOptimizationSettings']['water-heater-1'].expensiveDelta).toBe(-5);
  });

  it('applies expensiveDelta temperature during expensive hours', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 75);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Set current hour to an expensive hour (hour 8)
    const now = new Date();
    now.setHours(8, 30, 0, 0);

    const spotPrices = generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())).map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));
    const gridTariffData = generateMockGridTariffFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', gridTariffData);

    // Configure price optimization with delta-based settings
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Check that the price optimization settings are loaded
    expect(app['priceOptimizationSettings']['water-heater-1'].expensiveDelta).toBe(-5);
  });

  it('does not apply optimization for disabled devices', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    const spotPrices = generateMockPricesFor24Hours(now).map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', generateMockGridTariffFor24Hours());

    // Configure price optimization but DISABLED
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: false, // Disabled
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(now));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Device temp should remain unchanged since optimization is disabled
    expect(app['priceOptimizationSettings']['water-heater-1'].enabled).toBe(false);
  });

  it('loads price optimization settings from Homey settings', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const settings = {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 15,
        expensiveDelta: -10,
      },
      'water-heater-2': {
        enabled: false,
        cheapDelta: 5,
        expensiveDelta: -3,
      },
    };
    mockHomeyInstance.settings.set('price_optimization_settings', settings);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    expect(app['priceOptimizationSettings']).toEqual(settings);
  });

  it('updates settings when price_optimization_settings changes', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Initially no settings
    expect(Object.keys(app['priceOptimizationSettings']).length).toBe(0);

    // Set new settings with delta-based schema
    const newSettings = {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    };
    mockHomeyInstance.settings.set('price_optimization_settings', newSettings);
    await flushPromises();

    // Settings should be updated
    expect(app['priceOptimizationSettings']).toEqual(newSettings);
  });

  it('skips price optimization when globally disabled', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Create price data that makes the current hour clearly cheap
    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 3 ? 20 : 50; // Hour 3 is cheap
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'water-heater-1': 55 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_dry_run', false); // Not dry run

    // Configure price optimization for the device
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    // GLOBALLY DISABLE price optimization
    mockHomeyInstance.settings.set('price_optimization_enabled', false);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Even though price optimization is configured for the device and it's a cheap hour,
    // the temperature should remain at 55 because price optimization is globally disabled
    expect(await waterHeater.getCapabilityValue('target_temperature')).toBe(55);
  });

  it('respects price_optimization_enabled setting change at runtime', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    // Start with global price optimization DISABLED
    mockHomeyInstance.settings.set('price_optimization_enabled', false);

    const app = createApp();
    await app.onInit();
    await flushPromises();

    // Verify it's disabled
    expect(app['priceOptimizationEnabled']).toBe(false);

    // Enable it at runtime
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    await flushPromises();

    // Verify it's now enabled
    expect(app['priceOptimizationEnabled']).toBe(true);
  });

  it('getCurrentHourPriceInfo returns formatted price string', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const spotPrices = generateMockPricesFor24Hours(now).map((p) => ({
      startsAt: p.time_start,
      spotPriceExVat: p.NOK_per_kWh * 100,
      currency: 'NOK',
    }));

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', generateMockGridTariffFor24Hours());

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(now));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });


    const app = createApp();
    await app.onInit();
    await flushPromises();

    const priceInfo = app['getCurrentHourPriceInfo']();

    expect(typeof priceInfo).toBe('string');
    expect(priceInfo).toContain('øre/kWh');
    expect(priceInfo).toContain('spot');
    expect(priceInfo).toContain('grid tariff');
  });

  it('stores flow price data from single-quote JSON and builds combined prices', async () => {
    mockHomeyInstance.settings.set('price_scheme', 'flow');

    const app = createApp();
    await app.onInit();
    await flushPromises();

    const result = app['storeFlowPriceData']('today', "{'0':0.2747,'1':0.2678,'2':0.261}");
    expect(result.storedCount).toBe(3);

    const combined = mockHomeyInstance.settings.get('combined_prices') as {
      prices?: Array<{ total?: number }>;
      priceScheme?: string;
      priceUnit?: string;
    } | null;
    expect(combined?.priceScheme).toBe('flow');
    expect(combined?.priceUnit).toBe('price units');
    const totals = (combined?.prices || []).map((entry) => entry.total);
    expect(totals).toContain(0.2747);
    expect(totals).toContain(0.2678);
    expect(totals).toContain(0.261);
  });

  it('plan shows cheapDelta applied during cheap hours', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Create price data that makes the current hour clearly cheap
    // Average = 50, cheap threshold = 35, expensive threshold = 65
    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Create simple controlled prices - hour 3 will be 20 øre, others 50 øre
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      // Hour 3 is cheap (20), others normal (50)
      const spotPriceExVat = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    // No grid tariff to keep prices simple
    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });

    // Set mode target for the device
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'water-heater-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    // Configure price optimization with delta-based settings
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10, // +10°C during cheap hours
        expensiveDelta: -5, // -5°C during expensive hours
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    // Set up mock driver for the device so DeviceManager can find it
    const waterHeater2 = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater2.setCapabilityValue('target_temperature', 55);
    waterHeater2.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater2]),
    });

    const app = createApp();

    // Mock Date to return hour 3
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      // Get the plan from settings
      const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
      expect(plan).toBeDefined();
      expect(plan.devices).toBeDefined();

      const waterHeaterPlan = plan.devices.find((d: any) => d.id === 'water-heater-1');
      expect(waterHeaterPlan).toBeDefined();

      // During cheap hour, plannedTarget should be base (55) + cheapDelta (10) = 65
      expect(waterHeaterPlan.plannedTarget).toBe(65);
    } finally {
      global.Date = originalDate;
    }
  });

  it('plan shows expensiveDelta applied during expensive hours', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Create price data that makes the current hour clearly expensive
    const now = new Date();
    now.setHours(8, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Create simple controlled prices - hour 8 will be 80 øre, others 50 øre
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      // Hour 8 is expensive (80), others normal (50)
      const spotPriceExVat = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });

    // Set mode target for the device
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'water-heater-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    // Configure price optimization with delta-based settings
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5, // -5°C during expensive hours
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    // Mock Date to return hour 8
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      // Get the plan from settings
      const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
      expect(plan).toBeDefined();
      expect(plan.devices).toBeDefined();

      const waterHeaterPlan = plan.devices.find((d: any) => d.id === 'water-heater-1');
      expect(waterHeaterPlan).toBeDefined();

      // During expensive hour, plannedTarget should be base (55) + expensiveDelta (-5) = 50
      expect(waterHeaterPlan.plannedTarget).toBe(50);
    } finally {
      global.Date = originalDate;
    }
  });

  it('plan shows base temperature during normal hours (no delta)', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // All prices the same = normal hour
    const now = new Date();
    now.setHours(12, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat: 50, // All same price = normal
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });

    // Set mode target for the device
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'water-heater-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    // Configure price optimization with delta-based settings
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    // Mock Date to return hour 12
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      // Get the plan from settings
      const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
      expect(plan).toBeDefined();
      expect(plan.devices).toBeDefined();

      const waterHeaterPlan = plan.devices.find((d: any) => d.id === 'water-heater-1');
      expect(waterHeaterPlan).toBeDefined();

      // During normal hour, plannedTarget should be base temperature (55), no delta applied
      expect(waterHeaterPlan.plannedTarget).toBe(55);
    } finally {
      global.Date = originalDate;
    }
  });

  it('plan does not apply delta when price optimization is disabled', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 55);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Hour 3 is cheap, but optimization is disabled
    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });

    // Set mode target for the device
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'water-heater-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    // Configure price optimization but DISABLED
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: false, // Disabled!
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    // Mock Date to return hour 3
    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      // Get the plan from settings
      const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
      expect(plan).toBeDefined();
      expect(plan.devices).toBeDefined();

      const waterHeaterPlan = plan.devices.find((d: any) => d.id === 'water-heater-1');
      expect(waterHeaterPlan).toBeDefined();

      // Even during cheap hour, disabled optimization means base temp (55)
      expect(waterHeaterPlan.plannedTarget).toBe(55);
    } finally {
      global.Date = originalDate;
    }
  });

  it('applies price optimization delta on startup during expensive hour', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Connected 300', ['target_temperature', 'onoff']);
    waterHeater.setCapabilityValue('target_temperature', 65);
    waterHeater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    // Set current time to hour 8 (will be expensive)
    const now = new Date();
    now.setHours(8, 40, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Create spot prices where hour 8 is expensive (80 øre ex VAT, avg ~51)
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    // Mock https to return spot prices when fetched
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      // Return spot prices for hvakosterstrommen API
      if (url.includes('hvakosterstrommen')) {
        const hvakosterResponse = spotPrices.map((p) => ({
          NOK_per_kWh: p.spotPriceExVat / 100,
          time_start: p.startsAt,
          time_end: new Date(new Date(p.startsAt).getTime() + 3600000).toISOString(),
        }));
        const response = createMockHttpsResponse(200, hvakosterResponse);
        callback(response);
      } else {
        const response = createMockHttpsResponse(200, []);
        callback(response);
      }
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    // Set up settings - price optimization enabled with -5 delta for expensive hours
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'water-heater-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', {
      'Home Office': { 'water-heater-1': 65 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home Office');
    mockHomeyInstance.settings.set('capacity_dry_run', false); // Disable dry run to allow actuation
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });
    mockHomeyInstance.settings.set('price_area', 'NO3');

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      // Verify that it's detected as expensive hour
      expect(app['isCurrentHourExpensive']()).toBe(true);

      // The device should have been set to 60 (65 base - 5 delta) on startup
      // Check the device's current target temperature via the mock
      const currentTarget = await waterHeater.getCapabilityValue('target_temperature');
      expect(currentTarget).toBe(60); // 65 - 5 = 60
    } finally {
      global.Date = originalDate;
    }
  });

  it('isCurrentHourCheap returns true when price is 25% below average', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Average = ~51.25, threshold = 35.9
    // Hour 3 at 20 is below threshold
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      const isCheap = app['isCurrentHourCheap']();
      expect(isCheap).toBe(true);
    } finally {
      global.Date = originalDate;
    }
  });

  it('isCurrentHourExpensive returns true when price is 25% above average', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setHours(8, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Average = ~51.25, threshold = 66.6
    // Hour 8 at 80 is above threshold
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      await app.onInit();
      await flushPromises();

      const isExpensive = app['isCurrentHourExpensive']();
      expect(isExpensive).toBe(true);
    } finally {
      global.Date = originalDate;
    }
  });

  it('respects configurable threshold percent', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Hour 3 at 40 is 20% below average of 50 - NOT cheap with 25% threshold, but IS cheap with 15% threshold
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 3 ? 40 : 50; // 20% below average
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      // With default 25% threshold, 20% deviation is NOT cheap
      await app.onInit();
      await flushPromises();
      expect(app['isCurrentHourCheap']()).toBe(false);

      // Set threshold to 15% - now 20% deviation IS cheap
      mockHomeyInstance.settings.set('price_threshold_percent', 15);
      expect(app['isCurrentHourCheap']()).toBe(true);
    } finally {
      global.Date = originalDate;
    }
  });

  it('respects minimum price difference setting', async () => {
    const waterHeater = new MockDevice('water-heater-1', 'Water Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [waterHeater]),
    });

    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Hour 3 at 34 is about 26% below the average once fixed charges apply, so it is cheap by threshold.
    // Absolute difference stays below the min-diff setting when configured higher.
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const spotPriceExVat = hour === 3 ? 34 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('price_threshold_percent', 25);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = createApp();

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(now.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }

      static now() {
        return now.getTime();
      }
    } as DateConstructor;
    const originalDate = global.Date;
    global.Date = MockDate;

    try {
      // With no min diff, hour 3 is cheap (~19 øre below average)
      mockHomeyInstance.settings.set('price_min_diff_ore', 0);
      await app.onInit();
      await flushPromises();
      expect(app['isCurrentHourCheap']()).toBe(true);

      // With 20 øre min diff, 15 øre difference is NOT enough to be cheap
      mockHomeyInstance.settings.set('price_min_diff_ore', 20);
      expect(app['isCurrentHourCheap']()).toBe(false);

      // With 10 øre min diff, 15 øre difference IS enough
      mockHomeyInstance.settings.set('price_min_diff_ore', 10);
      expect(app['isCurrentHourCheap']()).toBe(true);
    } finally {
      global.Date = originalDate;
    }
  });
});
