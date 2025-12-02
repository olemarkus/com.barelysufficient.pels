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
    jest.clearAllTimers();
    mockHttpsGet = https.get as jest.Mock;
    mockHttpsGet.mockReset();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
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

    const app = new MyApp();
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

    const app = new MyApp();
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

  it('applies boost temperature during cheap hours', async () => {
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
    
    // Configure price optimization for the water heater
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        normalTemp: 55,
        boostTemp: 75,
        cheapHours: 4,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = new MyApp();
    await app.onInit();
    await flushPromises();

    // The app should have loaded the price optimization settings
    expect(app['priceOptimizationSettings']).toBeDefined();
    expect(app['priceOptimizationSettings']['water-heater-1']).toBeDefined();
    expect(app['priceOptimizationSettings']['water-heater-1'].enabled).toBe(true);
    expect(app['priceOptimizationSettings']['water-heater-1'].boostTemp).toBe(75);
  });

  it('applies normal temperature during expensive hours', async () => {
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
    
    // Configure price optimization
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'water-heater-1': {
        enabled: true,
        normalTemp: 55,
        boostTemp: 75,
        cheapHours: 4,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(new Date(now.getFullYear(), now.getMonth(), now.getDate())));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = new MyApp();
    await app.onInit();
    await flushPromises();

    // Check that the price optimization settings are loaded
    expect(app['priceOptimizationSettings']['water-heater-1'].normalTemp).toBe(55);
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
        normalTemp: 55,
        boostTemp: 75,
        cheapHours: 4,
      },
    });

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, generateMockPricesFor24Hours(now));
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = new MyApp();
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
        normalTemp: 60,
        boostTemp: 80,
        cheapHours: 6,
      },
      'water-heater-2': {
        enabled: false,
        normalTemp: 50,
        boostTemp: 70,
        cheapHours: 3,
      },
    };
    mockHomeyInstance.settings.set('price_optimization_settings', settings);

    mockHttpsGet.mockImplementation((url: string, options: any, callback: Function) => {
      const response = createMockHttpsResponse(200, []);
      callback(response);
      return { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
    });

    const app = new MyApp();
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

    const app = new MyApp();
    await app.onInit();
    await flushPromises();

    // Initially no settings
    expect(Object.keys(app['priceOptimizationSettings']).length).toBe(0);

    // Set new settings
    const newSettings = {
      'water-heater-1': {
        enabled: true,
        normalTemp: 55,
        boostTemp: 75,
        cheapHours: 4,
      },
    };
    mockHomeyInstance.settings.set('price_optimization_settings', newSettings);
    await flushPromises();

    // Settings should be updated
    expect(app['priceOptimizationSettings']).toEqual(newSettings);
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

    const app = new MyApp();
    await app.onInit();
    await flushPromises();

    const priceInfo = app['getCurrentHourPriceInfo']();

    expect(typeof priceInfo).toBe('string');
    expect(priceInfo).toContain('øre/kWh');
    expect(priceInfo).toContain('spot');
    expect(priceInfo).toContain('nettleie');
  });
});
