import { formatDisplayDeviceName } from '../../packages/shared-domain/src/displayDeviceName';

describe('formatDisplayDeviceName', () => {
  it('trims trailing whitespace from user-entered Homey names', () => {
    // Live-walk 2026-05-16: aria-label="Open device details for Termostat gang "
    expect(formatDisplayDeviceName('Termostat gang ')).toBe('Termostat gang');
  });

  it('trims leading and trailing whitespace symmetrically', () => {
    expect(formatDisplayDeviceName('  Lounge  ')).toBe('Lounge');
  });

  it('preserves internal whitespace (multi-word names)', () => {
    // "bad tredje" was one of the live-walk examples; the trailing space went
    // but the inner space must stay.
    expect(formatDisplayDeviceName('Lounge 2')).toBe('Lounge 2');
    expect(formatDisplayDeviceName('bad tredje ')).toBe('bad tredje');
  });

  it('returns an empty string for whitespace-only input so callers can fall back', () => {
    // The deadlines hero / deadline labels rely on `.trim() || fallback`;
    // matching that semantic keeps the helper drop-in compatible.
    expect(formatDisplayDeviceName('   ')).toBe('');
  });

  it('passes already-clean names through unchanged', () => {
    expect(formatDisplayDeviceName('Tesla')).toBe('Tesla');
  });
});
