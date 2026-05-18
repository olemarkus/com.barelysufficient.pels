import { describe, expect, it } from 'vitest';
import {
  computePaceContext,
  formatDeltaChipLabel,
  formatProjectionText,
  resolveHeroTone,
} from '../src/ui/usageHero.ts';

// Construct an instant that corresponds to UTC `hour:minute` on 2026-05-11.
const atUtcHour = (hour: number, minute = 0): Date => (
  new Date(Date.UTC(2026, 4, 11, hour, minute, 0))
);

// Construct an instant that corresponds to a local wall-clock `hour:minute` in
// the given IANA timezone on 2026-05-11. Used to make timezone-sensitive tests
// genuinely exercise zoned-hour extraction instead of trivially passing because
// of a UTC-on-UTC coincidence.
const atZonedHour = (timeZone: string, hour: number, minute = 0): Date => {
  const noonUtc = new Date(Date.UTC(2026, 4, 11, 12, 0, 0));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: 'numeric', minute: 'numeric',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(noonUtc).map((p) => [p.type, p.value]),
  );
  const localNoonHour = Number(parts.hour === '24' ? '0' : parts.hour);
  const offsetHours = localNoonHour - 12;
  return new Date(Date.UTC(2026, 4, 11, hour - offsetHours, minute, 0));
};

describe('computePaceContext', () => {
  it('reads the wall-clock hour from the supplied timezone, not the runtime', () => {
    // Construct an instant that is 09:00 local in America/New_York. If pace
    // ignored the timezone and used UTC, the elapsed-day fraction would be
    // ~9/24 only by coincidence — we'd see a different value at 22:00 UTC.
    const tz = 'America/New_York';
    const ctx = computePaceContext(3, 12, atZonedHour(tz, 9), tz);
    expect(ctx.fractionOfDay).toBeCloseTo(9 / 24, 2);
    // 3 kWh used vs 12 × 9/24 = 4.5 expected → −1.5 kWh diff.
    expect(ctx.expectedSoFar).toBeCloseTo(4.5, 1);
    expect(ctx.diff).toBeCloseTo(-1.5, 1);
  });

  it('returns expectedSoFar = 0 at midnight (no clamp bias)', () => {
    const ctx = computePaceContext(0, 12, atUtcHour(0, 0), 'UTC');
    expect(ctx.fractionOfDay).toBe(0);
    expect(ctx.expectedSoFar).toBe(0);
    expect(ctx.diff).toBe(0);
    // Projection is suppressed in the early-morning window.
    expect(ctx.projected).toBeNull();
  });

  it('suppresses projection in the first ~2.4 hours of the day', () => {
    const ctx = computePaceContext(0.4, 12, atUtcHour(0, 30), 'UTC');
    expect(ctx.fractionOfDay).toBeLessThan(0.1);
    expect(ctx.projected).toBeNull();
  });

  it('returns a finite projection after the early-morning window', () => {
    const ctx = computePaceContext(1.2, 12, atUtcHour(3, 0), 'UTC');
    expect(ctx.fractionOfDay).toBeGreaterThanOrEqual(0.1);
    expect(ctx.projected).not.toBeNull();
    expect(ctx.projected!).toBeCloseTo(9.6, 1);
  });

  it('handles zero typical day without dividing by zero', () => {
    const ctx = computePaceContext(2, 0, atUtcHour(6), 'UTC');
    expect(ctx.expectedSoFar).toBe(0);
    expect(ctx.diff).toBe(2);
  });

  it('accounts for the spring-forward 23-hour day in Europe/Oslo', () => {
    // 2026-03-29 02:00 local → 03:00 (DST start in CET → CEST). The local day
    // is 23 hours. Noon local on that day is 11 hours into a 23-hour day, so
    // fractionOfDay should be 11/23 ≈ 0.4783, not the flat 12/24 = 0.5.
    const tz = 'Europe/Oslo';
    // 12:00 Oslo on 2026-03-29 is 10:00 UTC (UTC+2 after DST).
    const noonLocal = new Date(Date.UTC(2026, 2, 29, 10, 0, 0));
    const ctx = computePaceContext(0, 23, noonLocal, tz);
    expect(ctx.fractionOfDay).toBeCloseTo(11 / 23, 2);
    expect(ctx.fractionOfDay).not.toBeCloseTo(0.5, 3);
  });
});

describe('formatDeltaChipLabel', () => {
  // When the projection window is open the chip mirrors the projected-vs-
  // typical baseline so it never disagrees with the projection prose
  // (TODO 490). Inside the early-morning window the chip falls back to the
  // elapsed-pace baseline since projection is suppressed.
  it('says "On track" inside the projected dead-band', () => {
    const ctx = computePaceContext(6.05, 12, atUtcHour(12), 'UTC');
    expect(formatDeltaChipLabel(ctx)).toEqual({ label: 'On track', tone: 'ok' });
  });

  it('reports a positive vs-typical delta with warn tone for moderate excess', () => {
    // 7 kWh by noon → projected 14 kWh → +2.0 vs typical 12 (16% > 10%).
    const ctx = computePaceContext(7, 12, atUtcHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.label).toBe('+2.0 kWh vs typical');
    expect(result.tone).toBe('warn');
  });

  it('escalates to alert tone past 25% over typical', () => {
    // 9 kWh by noon → projected 18 kWh → +6.0 vs typical 12 (50% > 25%).
    const ctx = computePaceContext(9, 12, atUtcHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.tone).toBe('alert');
    expect(result.label).toContain('vs typical');
  });

  it('reports a negative vs-typical delta with ok tone', () => {
    // 4 kWh by noon → projected 8 kWh → −4.0 vs typical 12.
    const ctx = computePaceContext(4, 12, atUtcHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.label).toBe('−4.0 kWh vs typical');
    expect(result.tone).toBe('ok');
  });

  it('falls back to vs-pace wording when projection is suppressed', () => {
    // 02:00 → fractionOfDay = 2/24 ≈ 0.083 < MIN_PROJECTION_FRACTION, so
    // projected is null and the chip falls back to the elapsed-pace baseline.
    // 2 kWh used vs expected 1 kWh by hour 2 → +1.0 kWh vs pace.
    const ctx = computePaceContext(2, 12, atUtcHour(2, 0), 'UTC');
    expect(ctx.projected).toBeNull();
    const result = formatDeltaChipLabel(ctx);
    expect(result.label).toContain('vs pace');
  });

  it('holds the chip at ok when the projected delta is above the dead-band but below the hero-tone gates', () => {
    // 6.2 kWh by noon → projected 12.4 → +0.4 vs typical 12. Above
    // PROJECTION_ON_TRACK_KWH (0.3) so the chip leaves the "On track"
    // dead-band, but the ratio (3.3%) and abs delta (0.4) sit below the
    // WARN gates (ratio > 10% AND absDiff ≥ 0.3). The chip tone must
    // remain `ok` so it never disagrees with the hero rim which already
    // returns `ok` in this region.
    const ctx = computePaceContext(6.2, 12, atUtcHour(12), 'UTC');
    const chip = formatDeltaChipLabel(ctx);
    expect(chip.tone).toBe('ok');
    expect(chip.label).toBe('+0.4 kWh vs typical');
    expect(resolveHeroTone(ctx)).toBe('ok');
  });
});

describe('formatProjectionText', () => {
  it('returns null while the projection window is suppressed', () => {
    const ctx = computePaceContext(0.4, 12, atUtcHour(0, 30), 'UTC');
    expect(formatProjectionText(ctx)).toBeNull();
  });

  it('uses a simple sentence when the projection lands near typical', () => {
    const ctx = computePaceContext(6, 12, atUtcHour(12), 'UTC');
    expect(formatProjectionText(ctx)).toBe('On track for ~12.0 kWh by midnight.');
  });

  it('keeps the projection figure but drops the duplicate delta number', () => {
    // The chip carries the kWh delta; the prose just names the direction.
    const high = computePaceContext(7.5, 12, atUtcHour(12), 'UTC');
    expect(formatProjectionText(high)).toBe('On track for ~15.0 kWh by midnight (above typical).');

    const low = computePaceContext(4, 12, atUtcHour(12), 'UTC');
    expect(formatProjectionText(low)).toBe('On track for ~8.0 kWh by midnight (below typical).');
  });
});

describe('resolveHeroTone', () => {
  it('returns ok when projected lands at typical', () => {
    expect(resolveHeroTone(computePaceContext(6, 12, atUtcHour(12), 'UTC'))).toBe('ok');
  });

  it('warns when projected lands meaningfully above typical', () => {
    expect(resolveHeroTone(computePaceContext(7, 12, atUtcHour(12), 'UTC'))).toBe('warn');
  });

  it('alerts when projected lands far above typical', () => {
    expect(resolveHeroTone(computePaceContext(9, 12, atUtcHour(12), 'UTC'))).toBe('alert');
  });

  it('does not alert on small absolute differences even with large percentage', () => {
    const ctx = computePaceContext(0.5, 12, atUtcHour(1, 0), 'UTC');
    expect(resolveHeroTone(ctx)).toBe('ok');
  });
});

