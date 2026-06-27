import { describe, expect, it } from 'vitest';
import {
  buildOpenMeteoIrradianceUrl,
  parseOpenMeteoRadiation,
} from '../../lib/solar/openMeteoIrradiance';

const HOUR_MS = 3_600_000;
const H0 = Date.UTC(2026, 5, 1, 10); // an exact UTC hour
const H1 = Date.UTC(2026, 5, 1, 11);
const sec = (ms: number): number => ms / 1000;

describe('buildOpenMeteoIrradianceUrl', () => {
  it('requests hourly shortwave radiation as unix time for the coordinates', () => {
    const url = buildOpenMeteoIrradianceUrl(59.913, 10.752);
    expect(url).toContain('latitude=59.9130');
    expect(url).toContain('longitude=10.7520');
    expect(url).toContain('hourly=shortwave_radiation');
    expect(url).toContain('timeformat=unixtime');
  });
});

describe('parseOpenMeteoRadiation', () => {
  // Open-Meteo radiation is a preceding-hour mean, so a stamp at T keys to the
  // hour starting at T − 1h. H0's value therefore lands at H0 − 1h, H1's at H0.
  it('maps each hour to its W/m², keyed to the interval-start (one hour before the stamp)', () => {
    const map = parseOpenMeteoRadiation({
      hourly: { time: [sec(H0), sec(H1)], shortwave_radiation: [420, 0] },
    });
    expect(map).toEqual({ [String(H0 - HOUR_MS)]: 420, [String(H0)]: 0 });
  });

  it('floors sub-hour timestamps to the hour, then shifts to the interval start', () => {
    const map = parseOpenMeteoRadiation({
      hourly: { time: [sec(H0) + 1800], shortwave_radiation: [300] }, // :30 past the hour
    });
    expect(map).toEqual({ [String(H0 - HOUR_MS)]: 300 });
  });

  it('drops malformed entries at the boundary (absence, never a fabricated 0)', () => {
    const map = parseOpenMeteoRadiation({
      hourly: {
        time: [sec(H0), sec(H1), sec(H0 + 2 * HOUR_MS), sec(H0 + 3 * HOUR_MS)],
        shortwave_radiation: [Number.NaN, -5, 'x', 250],
      },
    });
    // NaN, negative, and non-numeric radiation are skipped; only the valid hour
    // survives — stamped at H0+3h ⇒ keyed to H0+2h.
    expect(map).toEqual({ [String(H0 + 2 * HOUR_MS)]: 250 });
  });

  it('tolerates missing / ragged / non-array shapes', () => {
    expect(parseOpenMeteoRadiation(undefined)).toEqual({});
    expect(parseOpenMeteoRadiation({})).toEqual({});
    expect(parseOpenMeteoRadiation({ hourly: {} })).toEqual({});
    expect(parseOpenMeteoRadiation({ hourly: { time: 'no', shortwave_radiation: [1] } })).toEqual({});
    // Ragged: more timestamps than values ⇒ only the paired prefix is used.
    expect(parseOpenMeteoRadiation({
      hourly: { time: [sec(H0), sec(H1)], shortwave_radiation: [100] },
    })).toEqual({ [String(H0 - HOUR_MS)]: 100 });
  });
});
