import { describe, expect, it } from 'vitest';
import {
  computePaceContext,
  formatDeltaChipLabel,
  formatProjectionText,
  resolveHeroTone,
} from '../src/ui/power.ts';

// Build a Date that, when interpreted in `timeZone`, has the given local hour/minute.
const atLocalHour = (hour: number, minute = 0): Date => {
  const utcMs = Date.UTC(2026, 4, 11, hour, minute, 0);
  return new Date(utcMs);
};

describe('computePaceContext', () => {
  it('uses the supplied timezone, not the runtime local time', () => {
    const ctx = computePaceContext(6, 12, atLocalHour(12), 'UTC');
    expect(ctx.fractionOfDay).toBeCloseTo(0.5, 5);
    expect(ctx.expectedSoFar).toBeCloseTo(6, 5);
    expect(ctx.diff).toBeCloseTo(0, 5);
    expect(ctx.projected).toBeCloseTo(12, 5);
  });

  it('suppresses projection in the first ~2.4 hours of the day', () => {
    const ctx = computePaceContext(0.4, 12, atLocalHour(0, 30), 'UTC');
    expect(ctx.fractionOfDay).toBeLessThan(0.1);
    expect(ctx.projected).toBeNull();
  });

  it('returns a finite projection after the early-morning window', () => {
    const ctx = computePaceContext(1.2, 12, atLocalHour(3, 0), 'UTC');
    expect(ctx.fractionOfDay).toBeGreaterThanOrEqual(0.1);
    expect(ctx.projected).not.toBeNull();
    expect(ctx.projected!).toBeCloseTo(9.6, 1);
  });

  it('handles zero typical day without dividing by zero', () => {
    const ctx = computePaceContext(2, 0, atLocalHour(6), 'UTC');
    expect(ctx.expectedSoFar).toBe(0);
    expect(ctx.diff).toBe(2);
  });
});

describe('formatDeltaChipLabel', () => {
  it('says "On pace" inside the dead-band', () => {
    const ctx = computePaceContext(6.05, 12, atLocalHour(12), 'UTC');
    expect(formatDeltaChipLabel(ctx)).toEqual({ label: 'On pace', tone: 'ok' });
  });

  it('reports a positive delta with warn tone for moderate excess', () => {
    const ctx = computePaceContext(7, 12, atLocalHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.label.startsWith('+')).toBe(true);
    expect(result.tone).toBe('warn');
  });

  it('escalates to alert tone past 25% over expected', () => {
    const ctx = computePaceContext(9, 12, atLocalHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.tone).toBe('alert');
  });

  it('reports a negative delta with ok tone', () => {
    const ctx = computePaceContext(4, 12, atLocalHour(12), 'UTC');
    const result = formatDeltaChipLabel(ctx);
    expect(result.label.startsWith('−')).toBe(true);
    expect(result.tone).toBe('ok');
  });
});

describe('formatProjectionText', () => {
  it('returns null while the projection window is suppressed', () => {
    const ctx = computePaceContext(0.4, 12, atLocalHour(0, 30), 'UTC');
    expect(formatProjectionText(ctx)).toBeNull();
  });

  it('uses a simple sentence when the projection lands near typical', () => {
    const ctx = computePaceContext(6, 12, atLocalHour(12), 'UTC');
    expect(formatProjectionText(ctx)).toBe('On track for ~12.0 kWh by midnight.');
  });

  it('uses "above"/"below" wording outside the dead-band', () => {
    const high = computePaceContext(7.5, 12, atLocalHour(12), 'UTC');
    expect(formatProjectionText(high)).toMatch(/above typical\.$/);

    const low = computePaceContext(4, 12, atLocalHour(12), 'UTC');
    expect(formatProjectionText(low)).toMatch(/below typical\.$/);
  });
});

describe('resolveHeroTone', () => {
  it('returns ok when on pace', () => {
    expect(resolveHeroTone(computePaceContext(6, 12, atLocalHour(12), 'UTC'))).toBe('ok');
  });

  it('warns when meaningfully ahead of pace', () => {
    expect(resolveHeroTone(computePaceContext(7, 12, atLocalHour(12), 'UTC'))).toBe('warn');
  });

  it('alerts when far ahead of pace', () => {
    expect(resolveHeroTone(computePaceContext(9, 12, atLocalHour(12), 'UTC'))).toBe('alert');
  });

  it('does not alert on small absolute differences even with large percentage', () => {
    const ctx = computePaceContext(0.5, 12, atLocalHour(1, 0), 'UTC');
    expect(resolveHeroTone(ctx)).toBe('ok');
  });
});
