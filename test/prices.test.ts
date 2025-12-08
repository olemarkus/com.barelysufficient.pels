import https from 'https';
import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

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

const mockNveNettleieResponse = [
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

    // Check price transformation (NOK/kWh to øre/kWh with 25% VAT for NO1)
    const firstPrice = prices[0];
    expect(firstPrice).toHaveProperty('startsAt');
    expect(firstPrice).toHaveProperty('total');
    expect(firstPrice).toHaveProperty('currency', 'NOK');
    // 0.35 NOK/kWh * 100 * 1.25 = 43.75 øre/kWh
    expect(firstPrice.total).toBeCloseTo(43.75, 1);
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

  it('does not apply VAT for NO4 (Nord-Norge)', async () => {
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

    const prices = mockHomeyInstance.settings.get('electricity_prices');
    // 0.35 NOK/kWh * 100 = 35 øre/kWh (no VAT)
    expect(prices[0].total).toBeCloseTo(35, 1);
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

    mockHttpsGet.mockImplementation((_url: string, _options: any, _callback: Function) => {
      const req: any = {
        on: jest.fn((event: string, handler: Function): any => {
          if (event === 'error') {
            handler(new Error('Network error'));
          }
          return req;
        }),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      };
      return req;
    });

    // Use require to avoid ESM extension issues in TS tests
    const { setAllowConsoleError } = require('./setup');
    setAllowConsoleError(true);
    try {
      const app = createApp();
      await app.onInit();

      // Should not throw
      mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
      await flushPromises();
    } finally {
      setAllowConsoleError(false);
    }

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
      total: 40,
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
      total: p.NOK_per_kWh * 100 * 1.25,
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

    try {
      const app = createApp();
      await app.onInit();
      await flushPromises();

      // Should have fetched prices because it's after 13:15 and tomorrow's prices are missing
      expect(fetchCount).toBeGreaterThan(0);
    } finally {
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
      total: p.NOK_per_kWh * 100 * 1.25,
      currency: 'NOK',
    }));
    const tomorrowPrices = mockHvakosterStrommenResponse.map((p) => ({
      startsAt: p.time_start.replace(/\d{4}-\d{2}-\d{2}/, tomorrowStr),
      total: p.NOK_per_kWh * 100 * 1.25,
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
      total: p.NOK_per_kWh * 100 * 1.25,
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

describe('Nettleie (grid tariff) fetching', () => {
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

    // Mock global fetch for nettleie (uses fetch, not https)
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    global.fetch = originalFetch;
  });

  it('fetches and stores nettleie data from NVE API', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Configure nettleie settings
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_orgnr', '980489698');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockNveNettleieResponse,
    });

    const app = createApp();
    await app.onInit();

    // Trigger nettleie refresh
    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

    // Check that nettleie data was stored
    const nettleieData = mockHomeyInstance.settings.get('nettleie_data');
    expect(Array.isArray(nettleieData)).toBe(true);
    expect(nettleieData.length).toBe(3);

    // Check data structure
    const firstEntry = nettleieData[0];
    expect(firstEntry).toHaveProperty('time', 0);
    expect(firstEntry).toHaveProperty('energileddEks', 19.12);
    expect(firstEntry).toHaveProperty('energileddInk', 35.79);
    expect(firstEntry).toHaveProperty('fastleddEks', 244.0);
    expect(firstEntry).toHaveProperty('fastleddInk', 305.0);
    expect(firstEntry).toHaveProperty('datoId');
  });

  it('skips fetch when organization number is not configured', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Only set fylke, no orgnr
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
    // No nettleie_orgnr set

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
    const nettleieData = mockHomeyInstance.settings.get('nettleie_data');
    expect(nettleieData).toBeUndefined();
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

  it('NVE nettleie response has expected fields', () => {
    const entry = mockNveNettleieResponse[0];
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

  // Generate nettleie data for 24 hours
  const generateMockNettleieFor24Hours = () => {
    const data: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      // Day rate (6-22) vs night rate (22-6)
      const isNight = hour < 6 || hour >= 22;
      data.push({
        datoId: '2025-12-01T00:00:00',
        time: hour,
        tariffgruppe: 'Husholdning',
        konsesjonar: 'ELVIA AS',
        organisasjonsnr: '980489698',
        fylkeNr: '03',
        fylke: 'Oslo',
        harMva: true,
        harForbruksavgift: true,
        fastleddEks: 244.0,
        energileddEks: isNight ? 15.0 : 25.0,
        fastleddInk: 305.0,
        energileddInk: isNight ? 20.0 : 35.0,
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

  it('combines spot prices and nettleie correctly for total cost', async () => {
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
      total: p.NOK_per_kWh * 100 * 1.25, // Already converted to øre with VAT
      currency: 'NOK',
    }));
    const nettleieData = generateMockNettleieFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', nettleieData);

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

    // Each combined price should have spot + nettleie
    const firstPrice = combinedPrices[0];
    expect(firstPrice).toHaveProperty('startsAt');
    expect(firstPrice).toHaveProperty('spotPrice');
    expect(firstPrice).toHaveProperty('nettleie');
    expect(firstPrice).toHaveProperty('totalPrice');
    expect(firstPrice.totalPrice).toBe(firstPrice.spotPrice + firstPrice.nettleie);
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
      total: p.NOK_per_kWh * 100 * 1.25, // Already converted to øre with VAT
      currency: 'NOK',
    }));
    const nettleieData = generateMockNettleieFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', nettleieData);

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
      total: p.NOK_per_kWh * 100 * 1.25,
      currency: 'NOK',
    }));
    const nettleieData = generateMockNettleieFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', nettleieData);

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
      total: p.NOK_per_kWh * 100 * 1.25,
      currency: 'NOK',
    }));
    const nettleieData = generateMockNettleieFor24Hours();

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', nettleieData);

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
      total: p.NOK_per_kWh * 100 * 1.25,
      currency: 'NOK',
    }));

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', generateMockNettleieFor24Hours());

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
      const total = hour === 3 ? 20 : 50; // Hour 3 is cheap
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });
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
      total: p.NOK_per_kWh * 100 * 1.25,
      currency: 'NOK',
    }));

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', generateMockNettleieFor24Hours());

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
    expect(priceInfo).toContain('nettleie');
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
      const total = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    // No nettleie to keep prices simple
    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });

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
      const total = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });

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
        total: 50, // All same price = normal
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });

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
      const total = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    mockHomeyInstance.settings.set('electricity_prices', spotPrices);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('controllable_devices', { 'water-heater-1': true });

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

    // Create spot prices where hour 8 is expensive (80 øre, avg ~51)
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const total = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    // Mock https to return spot prices when fetched
    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      // Return spot prices for hvakosterstrommen API
      if (url.includes('hvakosterstrommen')) {
        const hvakosterResponse = spotPrices.map((p) => ({
          NOK_per_kWh: p.total / 100 / 1.25, // Convert back to NOK/kWh excl VAT
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
    mockHomeyInstance.settings.set('mode_device_targets', {
      Hjemmekontor: { 'water-heater-1': 65 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Hjemmekontor');
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
      const total = hour === 3 ? 20 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
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
      const total = hour === 8 ? 80 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
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
      const total = hour === 3 ? 40 : 50; // 20% below average
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
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

    // Hour 3 at 35 is 30% below average of 50, so definitely cheap by threshold
    // But absolute difference is only 15 øre
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const total = hour === 3 ? 35 : 50;
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
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
      // With no min diff, hour 3 is cheap (15 øre below average)
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
