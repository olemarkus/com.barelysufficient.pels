import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// Mock the https module
jest.mock('https', () => ({
  get: jest.fn(),
}));

import https from 'https';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date', 'nextTick'] });

// app.ts uses CommonJS export (module.exports = class ...)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

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
    jest.clearAllTimers();
    mockHttpsGet = https.get as jest.Mock;
    mockHttpsGet.mockReset();
  });

  afterEach(() => {
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

    const app = new MyApp();
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

    const app = new MyApp();
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

    const app = new MyApp();
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

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
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

    const app = new MyApp();
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

    const app = new MyApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_spot_prices', Date.now());
    await flushPromises();

    // Should use NO1 as default
    expect(capturedUrl).toContain('_NO1.json');
  });
});

describe('Nettleie (grid tariff) fetching', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    jest.clearAllTimers();

    // Mock global fetch for nettleie (uses fetch, not https)
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
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

    const app = new MyApp();
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

    const app = new MyApp();
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

    const app = new MyApp();
    await app.onInit();

    // Should not throw
    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

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

    const app = new MyApp();
    await app.onInit();

    mockHomeyInstance.settings.set('refresh_nettleie', Date.now());
    await flushPromises();

    // Check URL contains correct parameters
    expect(capturedUrl).toContain('nettleietariffer.dataplattform.nve.no');
    expect(capturedUrl).toContain('FylkeNr=46');
    expect(capturedUrl).toContain('OrganisasjonsNr=976944801');
    expect(capturedUrl).toContain('Tariffgruppe=Hytter%20og%20fritidshus');
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
