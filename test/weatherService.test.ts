
import { WeatherService } from '../lib/core/weatherService';

// Mock global fetch
global.fetch = jest.fn();

class MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    private body: string;

    constructor(body: string, init?: { status?: number; statusText?: string }) {
        this.body = body;
        this.status = init?.status ?? 200;
        this.statusText = init?.statusText ?? 'OK';
        this.ok = this.status >= 200 && this.status < 300;
    }

    async json() {
        return JSON.parse(this.body);
    }
}


describe('WeatherService', () => {
    let service: WeatherService;
    let mockLog: jest.Mock;
    let mockError: jest.Mock;

    beforeEach(() => {
        mockLog = jest.fn();
        mockError = jest.fn();
        service = new WeatherService({ log: mockLog, error: mockError });
        jest.clearAllMocks();
    });

    test('getForecast returns transformed data on success', async () => {
        const mockData = {
            properties: {
                timeseries: [
                    {
                        time: '2023-10-27T12:00:00Z',
                        data: { instant: { details: { air_temperature: 10.5 } } },
                    },
                    {
                        time: '2023-10-27T13:00:00Z',
                        data: { instant: { details: { air_temperature: 11.2 } } },
                    },
                ],
            },
        };

        (global.fetch as jest.Mock).mockResolvedValue(new MockResponse(JSON.stringify(mockData), { status: 200 }));

        const forecast = await service.getForecast(60, 10);

        expect(forecast).toHaveLength(2);
        expect(forecast[0].time).toBe('2023-10-27T12:00:00Z');
        expect(forecast[0].air_temperature).toBe(10.5);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Fetching weather'));
    });

    test('getForecast handles API errors gracefully', async () => {
        (global.fetch as jest.Mock).mockResolvedValue(new MockResponse('Error', { status: 500, statusText: 'Internal Server Error' }));

        const forecast = await service.getForecast(60, 10);

        expect(forecast).toEqual([]);
        expect(mockError).toHaveBeenCalledWith('Failed to fetch weather forecast', expect.any(Error));
    });

    test('getForecast returns cached data if called frequently', async () => {
        const mockData = {
            properties: {
                timeseries: [{ time: '2023-10-27T12:00:00Z', data: { instant: { details: { air_temperature: 10.5 } } } }],
            },
        };
        (global.fetch as jest.Mock).mockResolvedValue(new MockResponse(JSON.stringify(mockData), { status: 200 }));

        await service.getForecast(60, 10);
        await service.getForecast(60, 10); // Should be cached

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
