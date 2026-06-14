import {
  buildMetForecastUrl,
  fetchMetForecast,
  summarizeMetForecastDays,
  type MetDaySummaryWithCoverage,
  type MetForecastDays,
  type MetForecastFetchDeps,
} from '../../lib/weather/metForecast';

const OSLO = 'Europe/Oslo';

const TOMORROW_KEY = '2026-06-15';
const TODAY_KEY = '2026-06-14';

/** The tomorrow summary from a per-day result (the day the readout card reads). */
const tomorrowOf = (days: MetForecastDays | null): MetDaySummaryWithCoverage | undefined => (
  days?.byDay[TOMORROW_KEY]
);

type Extra = { next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } } };

/** One MET compact entry; `utcMs` is the instant, temp goes in instant.details. */
const entry = (utcMs: number, tempC: number, extra: Extra = {}): unknown => ({
  time: new Date(utcMs).toISOString(),
  data: { instant: { details: { air_temperature: tempC } }, ...extra },
});

const envelope = (entries: unknown[]): unknown => ({ properties: { timeseries: entries } });

// Oslo is UTC+2 in summer; local hour H on 2026-06-DD == UTC (H-2).
const osloOn = (dayOfMonth: number, localHour: number, tempC: number, extra: Extra = {}): unknown => (
  entry(Date.UTC(2026, 5, dayOfMonth, localHour, 0, 0) - 2 * 3600e3, tempC, extra)
);
// Default anchor is tomorrow (2026-06-15) for the now used in this file.
const osloSummer = (localHour: number, tempC: number, extra: Extra = {}): unknown => (
  osloOn(15, localHour, tempC, extra)
);

// now = 2026-06-14 12:00 Oslo → today 2026-06-14, tomorrow 2026-06-15.
const NOW_SUMMER = Date.UTC(2026, 5, 14, 10, 0, 0);

describe('summarizeMetForecastDays', () => {
  it('reduces tomorrow to mean/min/max with a SIMPLE per-hour mean', () => {
    // temp == local hour (0..23): mean = 11.5, min 0, max 23 — proves an unweighted mean.
    const entries = Array.from({ length: 24 }, (_, h) => osloSummer(h, h));
    const days = summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER });
    expect(days).not.toBeNull();
    const summary = tomorrowOf(days);
    expect(summary?.dateKey).toBe(TOMORROW_KEY);
    expect(summary?.meanTempC).toBeCloseTo(11.5, 6);
    expect(summary?.minTempC).toBe(0);
    expect(summary?.maxTempC).toBe(23);
    expect(summary?.hourCount).toBe(24);
    expect(summary?.fullDayCoverage).toBe(true);
  });

  it('summarizes BOTH the current local day and tomorrow into byDay', () => {
    // 12 hourly points on the current local day (local 12..23 today, all 30 °C)
    // plus a full 24 h on tomorrow (all 5 °C) — each consumer reads its own day.
    const today = Array.from({ length: 12 }, (_, h) => osloOn(14, h + 12, 30)); // local 12..23 today
    const tomorrow = Array.from({ length: 24 }, (_, h) => osloOn(15, h, 5)); // local 0..23 tomorrow
    const days = summarizeMetForecastDays(
      envelope([...today, ...tomorrow]),
      { timeZone: OSLO, nowMs: NOW_SUMMER },
    );
    expect(Object.keys(days?.byDay ?? {}).sort()).toEqual([TODAY_KEY, TOMORROW_KEY]);
    expect(days?.byDay[TODAY_KEY]?.dateKey).toBe(TODAY_KEY);
    expect(days?.byDay[TODAY_KEY]?.meanTempC).toBeCloseTo(30, 6);
    expect(days?.byDay[TODAY_KEY]?.hourCount).toBe(12);
    expect(days?.byDay[TOMORROW_KEY]?.meanTempC).toBeCloseTo(5, 6);
    expect(days?.byDay[TOMORROW_KEY]?.hourCount).toBe(24);
  });

  it('matches a plain arithmetic mean on non-uniform temps (not integrated/weighted)', () => {
    const temps = [5, 5, 5, 5, 20, 20]; // mean 10
    const entries = temps.map((t, i) => osloSummer(i, t));
    const days = summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER });
    expect(tomorrowOf(days)?.meanTempC).toBeCloseTo(10, 6);
  });

  it('captures the evening window (local 17–23) min/mean', () => {
    const entries = Array.from({ length: 24 }, (_, h) => osloSummer(h, h));
    const summary = tomorrowOf(summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER }));
    // evening hours 17..23 → temps 17..23, min 17, mean 20.
    expect(summary?.eveningHourCount).toBe(7);
    expect(summary?.eveningMinTempC).toBe(17);
    expect(summary?.eveningMeanTempC).toBeCloseTo(20, 6);
  });

  it('buckets to the LOCAL day — tomorrow excludes today and the day after', () => {
    const tomorrow = Array.from({ length: 24 }, (_, h) => osloSummer(h, 5));
    const todayLate = entry(Date.UTC(2026, 5, 14, 12, 0, 0), 999); // local 14:00 today
    const dayAfter = entry(Date.UTC(2026, 5, 16, 12, 0, 0), 999); // local 14:00 day after
    const days = summarizeMetForecastDays(
      envelope([todayLate, ...tomorrow, dayAfter]),
      { timeZone: OSLO, nowMs: NOW_SUMMER },
    );
    const summary = tomorrowOf(days);
    expect(summary?.hourCount).toBe(24);
    expect(summary?.maxTempC).toBe(5); // the day-after 999 sentinel was excluded from tomorrow
    // The day-after sentinel never lands in byDay; today's single point does.
    expect(Object.keys(days?.byDay ?? {}).sort()).toEqual([TODAY_KEY, TOMORROW_KEY]);
  });

  it('still summarizes a partial day but flags coverage false', () => {
    const entries = Array.from({ length: 6 }, (_, h) => osloSummer(h, h)); // only 6 night hours
    const summary = tomorrowOf(summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER }));
    expect(summary?.hourCount).toBe(6);
    expect(summary?.fullDayCoverage).toBe(false);
    expect(summary?.eveningHourCount).toBe(0);
    expect(summary?.eveningMinTempC).toBeUndefined();
  });

  it('flags coverage false for an early-morning boot that misses midnight despite a high count', () => {
    // 03:00–23:00 = 21 hours (above the count threshold) but NO local hour 0 — a
    // same-day restart that dropped the pre-dawn hours. True full-day coverage
    // requires the midnight hour, so this must NOT count as a full day.
    const entries = Array.from({ length: 21 }, (_, i) => osloSummer(i + 3, i + 3));
    const summary = tomorrowOf(summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER }));
    expect(summary?.hourCount).toBe(21);
    expect(summary?.fullDayCoverage).toBe(false);
  });

  it('surfaces the midday glyph and total precipitation (display-only)', () => {
    const entries = Array.from({ length: 24 }, (_, h) => osloSummer(
      h, 5, { next_1_hours: { summary: { symbol_code: h === 12 ? 'snow' : 'cloudy' }, details: { precipitation_amount: 0.5 } } },
    ));
    const summary = tomorrowOf(summarizeMetForecastDays(envelope(entries), { timeZone: OSLO, nowMs: NOW_SUMMER }));
    expect(summary?.symbolCode).toBe('snow'); // entry nearest local noon
    expect(summary?.precipMmTotal).toBeCloseTo(12, 6); // 24 × 0.5
  });

  it('returns null when no entries fall on today or tomorrow', () => {
    const dayAfterOnly = [entry(Date.UTC(2026, 5, 16, 8, 0, 0), 10)];
    expect(summarizeMetForecastDays(envelope(dayAfterOnly), { timeZone: OSLO, nowMs: NOW_SUMMER })).toBeNull();
  });

  it('returns a today-only result when tomorrow has no data', () => {
    const todayOnly = [entry(Date.UTC(2026, 5, 14, 8, 0, 0), 10)]; // local 10:00 today
    const days = summarizeMetForecastDays(envelope(todayOnly), { timeZone: OSLO, nowMs: NOW_SUMMER });
    expect(Object.keys(days?.byDay ?? {})).toEqual([TODAY_KEY]);
    expect(tomorrowOf(days)).toBeUndefined();
  });

  it('returns null for empty / malformed envelopes', () => {
    expect(summarizeMetForecastDays(null, { timeZone: OSLO, nowMs: NOW_SUMMER })).toBeNull();
    expect(summarizeMetForecastDays({}, { timeZone: OSLO, nowMs: NOW_SUMMER })).toBeNull();
    expect(summarizeMetForecastDays(envelope([]), { timeZone: OSLO, nowMs: NOW_SUMMER })).toBeNull();
    expect(summarizeMetForecastDays(envelope([{ time: 'not-a-date', data: {} }]), { timeZone: OSLO, nowMs: NOW_SUMMER })).toBeNull();
  });

  it('skips entries missing a finite air_temperature', () => {
    const good = Array.from({ length: 23 }, (_, h) => osloSummer(h, 5));
    const bad = { time: new Date(Date.UTC(2026, 5, 15, 21, 0, 0) - 2 * 3600e3).toISOString(), data: { instant: { details: {} } } };
    const summary = tomorrowOf(summarizeMetForecastDays(envelope([...good, bad]), { timeZone: OSLO, nowMs: NOW_SUMMER }));
    expect(summary?.hourCount).toBe(23);
  });

  // DST: bucket COUNT proves local-day bucketing handles 23/25-hour days. Generate
  // an entry at every UTC hour across a wide window and count tomorrow's bucket.
  const utcHourlyAcross = (startUtcMs: number, hours: number): unknown[] => (
    Array.from({ length: hours }, (_, i) => entry(startUtcMs + i * 3600e3, 5))
  );

  it('buckets a 25-hour local day (Oslo autumn fall-back) as 25 hours', () => {
    // Oslo falls back 2026-10-25 (clocks 03:00→02:00) → a 25-hour local day.
    const now = Date.UTC(2026, 9, 24, 10, 0, 0); // 2026-10-24, tomorrow = 2026-10-25
    const start = Date.UTC(2026, 9, 24, 0, 0, 0);
    const summary = summarizeMetForecastDays(
      envelope(utcHourlyAcross(start, 72)),
      { timeZone: OSLO, nowMs: now },
    )?.byDay['2026-10-25'];
    expect(summary?.dateKey).toBe('2026-10-25');
    expect(summary?.hourCount).toBe(25);
  });

  it('buckets a 23-hour local day (Oslo spring-forward) as 23 hours', () => {
    // Oslo springs forward 2026-03-29 (clocks 02:00→03:00) → a 23-hour local day.
    const now = Date.UTC(2026, 2, 28, 10, 0, 0); // 2026-03-28, tomorrow = 2026-03-29
    const start = Date.UTC(2026, 2, 28, 0, 0, 0);
    const summary = summarizeMetForecastDays(
      envelope(utcHourlyAcross(start, 72)),
      { timeZone: OSLO, nowMs: now },
    )?.byDay['2026-03-29'];
    expect(summary?.dateKey).toBe('2026-03-29');
    expect(summary?.hourCount).toBe(23);
  });
});

describe('buildMetForecastUrl', () => {
  it('rounds coordinates to 4 decimals (MET over-precision guard)', () => {
    expect(buildMetForecastUrl(59.913868, 10.752245)).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.9139&lon=10.7522',
    );
  });
});

describe('fetchMetForecast', () => {
  // Minimal fetch-response stub. Returned through an `as unknown as typeof fetch`
  // cast at the call site, so the experimental `Response` global is never named.
  const stubResponse = (init: {
    status?: number; ok?: boolean; statusText?: string; json?: unknown; headers?: Record<string, string>;
  }) => ({
    status: init.status ?? 200,
    ok: init.ok ?? true,
    statusText: init.statusText ?? 'OK',
    json: async () => init.json,
    headers: { get: (key: string) => init.headers?.[key.toLowerCase()] ?? null },
  });

  const baseDeps = (over: Partial<MetForecastFetchDeps> = {}): MetForecastFetchDeps => ({
    latitude: 59.91, longitude: 10.75, timeZone: OSLO, nowMs: NOW_SUMMER,
    userAgent: 'com.barelysufficient.pels/2.x (test@example.com)',
    ...over,
  });

  it('returns no_location for NaN or (0,0) and never fetches', async () => {
    const fetchImpl = vi.fn();
    expect((await fetchMetForecast(baseDeps({ latitude: Number.NaN, fetchImpl: fetchImpl as unknown as typeof fetch }))).outcome).toBe('no_location');
    expect((await fetchMetForecast(baseDeps({ latitude: 0, longitude: 0, fetchImpl: fetchImpl as unknown as typeof fetch }))).outcome).toBe('no_location');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the User-Agent and parses a 200 into a summary + caching headers', async () => {
    const entries = Array.from({ length: 24 }, (_, h) => osloSummer(h, h));
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => stubResponse({
      json: envelope(entries), headers: { expires: 'Mon, 15 Jun 2026 06:00:00 GMT', 'last-modified': 'Sun, 14 Jun 2026 05:00:00 GMT' },
    }));
    const result = await fetchMetForecast(baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.days.byDay[TOMORROW_KEY]?.meanTempC).toBeCloseTo(11.5, 6);
      expect(result.expires).toBe('Mon, 15 Jun 2026 06:00:00 GMT');
      expect(result.lastModified).toBe('Sun, 14 Jun 2026 05:00:00 GMT');
    }
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('com.barelysufficient.pels');
  });

  it('passes If-Modified-Since and maps 304 to not_modified', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => stubResponse({ status: 304, ok: false }));
    const result = await fetchMetForecast(baseDeps({
      ifModifiedSince: 'Sun, 14 Jun 2026 05:00:00 GMT', fetchImpl: fetchImpl as unknown as typeof fetch,
    }));
    expect(result.outcome).toBe('not_modified');
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers['If-Modified-Since']).toBe('Sun, 14 Jun 2026 05:00:00 GMT');
  });

  it('maps a non-ok status to failed', async () => {
    const fetchImpl = vi.fn(async () => stubResponse({ status: 429, ok: false, statusText: 'Too Many Requests' }));
    expect((await fetchMetForecast(baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).outcome).toBe('failed');
  });

  it('maps a thrown fetch to failed (transient — caller keeps cache/persistence)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    expect((await fetchMetForecast(baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).outcome).toBe('failed');
  });

  it('maps a 200 with no tomorrow data to failed', async () => {
    const fetchImpl = vi.fn(async () => stubResponse({ json: envelope([]) }));
    expect((await fetchMetForecast(baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).outcome).toBe('failed');
  });

  it('aborts and maps to failed when the fetch hangs past the timeout (cache kept)', async () => {
    // A fetch that resolves only when its AbortSignal fires — proving the bounded
    // timeout aborts a hung socket instead of stalling the rollup loop forever.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = await fetchMetForecast(baseDeps({
      timeoutMs: 5, fetchImpl: fetchImpl as unknown as typeof fetch,
    }));
    expect(result.outcome).toBe('failed');
  });

  it('carries the 304 caching validators back to the caller', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => stubResponse({
      status: 304, ok: false, headers: { expires: 'Mon, 15 Jun 2026 07:00:00 GMT', 'last-modified': 'Sun, 14 Jun 2026 06:00:00 GMT' },
    }));
    const result = await fetchMetForecast(baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result.outcome).toBe('not_modified');
    if (result.outcome === 'not_modified') {
      expect(result.expires).toBe('Mon, 15 Jun 2026 07:00:00 GMT');
      expect(result.lastModified).toBe('Sun, 14 Jun 2026 06:00:00 GMT');
    }
  });
});
