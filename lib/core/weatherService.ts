export type WeatherForecast = {
    time: string; // ISO string
    air_temperature: number;
};

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

/**
 * Service for fetching weather forecasts from Met.no.
 * Features:
 * - Fetches hourly air temperature forecasts.
 * - Caches results for 1 hour to respect API rate limits.
 * - Validates input coordinates.
 * - Filters out incomplete data.
 * - Returns last known good forecast on failure.
 */
export class WeatherService {
    private userAgent = 'PELS-Controller/1.0';
    private baseUrl = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
    private lastForecast: WeatherForecast[] = [];
    private lastFetchTime = 0;
    private fetchInterval = 1000 * 60 * 60; // 1 hour
    private lastFetchLat: number | null = null;
    private lastFetchLon: number | null = null;

    constructor(private deps: WeatherServiceDeps) { }

    private areCoordinatesValid(lat: number, lon: number): boolean {
        const latIsValid = Number.isFinite(lat) && lat >= -90 && lat <= 90;
        const lonIsValid = Number.isFinite(lon) && lon >= -180 && lon <= 180;
        return latIsValid && lonIsValid;
    }

    private isCacheValid(lat: number, lon: number): boolean {
        return (
            this.lastForecast.length > 0
            && this.lastFetchLat === lat
            && this.lastFetchLon === lon
            && Date.now() - this.lastFetchTime < this.fetchInterval
        );
    }

    private async fetchForecastData(lat: number, lon: number): Promise<MetNoResponse> {
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

        return await response.json() as MetNoResponse;
    }

    private extractForecast(data: MetNoResponse): WeatherForecast[] {
        const timeseries = data?.properties?.timeseries || [];
        const validTimeseries = timeseries.filter((entry) =>
            entry.data?.instant?.details?.air_temperature !== undefined,
        );

        if (validTimeseries.length !== timeseries.length) {
            this.deps.error(
                `Weather API response missing air_temperature for ${timeseries.length - validTimeseries.length} time series entries`,
            );
        }

        return validTimeseries.slice(0, 24).map((entry) => ({
            time: entry.time,
            air_temperature: entry.data!.instant!.details!.air_temperature as number,
        }));
    }

    /**
     * Fetches the next 24h hourly forecast for the given coordinates.
     * Returns cached or last known forecast on failure.
     */
    async getForecast(lat: number, lon: number): Promise<WeatherForecast[]> {
        if (!this.areCoordinatesValid(lat, lon)) {
            this.deps.error('Invalid coordinates for weather forecast', { lat, lon });
            return this.lastForecast.length > 0 ? this.lastForecast : [];
        }

        if (this.isCacheValid(lat, lon)) {
            return this.lastForecast;
        }

        try {
            const data = await this.fetchForecastData(lat, lon);
            this.lastForecast = this.extractForecast(data);

            this.lastFetchTime = Date.now();
            this.lastFetchLat = lat;
            this.lastFetchLon = lon;
            return this.lastForecast;

        } catch (error) {
            this.deps.error('Failed to fetch weather forecast', error);
            return this.lastForecast.length > 0 ? this.lastForecast : [];
        }
    }
}
