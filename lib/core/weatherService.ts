// @ts-expect-error node-fetch is not typed in this environment
import fetch from 'node-fetch';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */


export type WeatherForecast = {
    time: string; // ISO string
    air_temperature: number;
}

export type WeatherServiceDeps = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

type MetNoTimeSeriesEntry = {
    time: string;
    data: {
        instant: {
            details: {
                air_temperature?: number;
            };
        };
    };
};

type MetNoResponse = {
    properties: {
        timeseries: MetNoTimeSeriesEntry[];
    };
};

export class WeatherService {
    private userAgent = 'PELS-Controller/1.0';
    private baseUrl = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
    private lastForecast: WeatherForecast[] = [];
    private lastFetchTime = 0;
    private fetchInterval = 1000 * 60 * 60; // 1 hour

    constructor(private deps: WeatherServiceDeps) { }

    async getForecast(lat: number, lon: number): Promise<WeatherForecast[]> {
        if (this.lastForecast.length > 0 && Date.now() - this.lastFetchTime < this.fetchInterval) {
            return this.lastForecast;
        }

        try {
            const url = `${this.baseUrl}?lat=${lat}&lon=${lon}`;
            this.deps.log(`Fetching weather from ${url}`);

            const response = await fetch(url, {
                headers: {
                    'User-Agent': this.userAgent,
                },
            });

            if (!response.ok) {
                throw new Error(`Weather API failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as MetNoResponse;
            const timeseries = data?.properties?.timeseries || [];

            this.lastForecast = timeseries.slice(0, 24).map((entry) => ({
                time: entry.time,
                air_temperature: entry.data?.instant?.details?.air_temperature ?? 0,
            }));

            this.lastFetchTime = Date.now();
            return this.lastForecast;

        } catch (error) {
            this.deps.error('Failed to fetch weather forecast', error);
            return this.lastForecast.length > 0 ? this.lastForecast : [];
        }
    }
}
