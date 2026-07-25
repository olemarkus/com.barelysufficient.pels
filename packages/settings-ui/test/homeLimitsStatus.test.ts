import { describe, expect, it } from 'vitest';
import {
  homeScopedSettingsKey,
  MAIN_HOME_ID,
} from '../../contracts/src/settingsKeys.ts';
import {
  composeHomeLimitsStateLine,
  formatHomeLimitsKw,
  HOME_LIMITS_STATUS_ACTIVE_IDLE,
  HOME_LIMITS_STATUS_AWAITING_READING,
  HOME_LIMITS_STATUS_PENDING,
  HOME_LIMITS_STATUS_SHORTFALL,
  HOME_LIMITS_STATUS_SIMULATING_IDLE,
  resolveHomeLimitsPostureChip,
  resolveHomeLimitsStatus,
} from '../../shared-domain/src/homeLimitsStatus.ts';
import { composeHomeLimitsSimulationNotice } from '../../shared-domain/src/homeLimitsCopy.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Limits status boundary resolver + copy (multi-home U3). Pins the
 * key-scoping mirror (main = bare, meter area = suffixed), the untrusted-blob
 * shaping, and the simulation-honest state lines.
 * -------------------------------------------------------------------------- */

describe('homeScopedSettingsKey mirror', () => {
  it('keeps the Main home on the bare key (byte-identical)', () => {
    expect(homeScopedSettingsKey('capacity_limit_kw', MAIN_HOME_ID)).toBe('capacity_limit_kw');
    expect(homeScopedSettingsKey('capacity_dry_run', 'main')).toBe('capacity_dry_run');
    expect(homeScopedSettingsKey('pels_status', MAIN_HOME_ID)).toBe('pels_status');
  });

  it('suffixes a meter area with :<homeId>', () => {
    expect(homeScopedSettingsKey('capacity_limit_kw', 'h_abc')).toBe('capacity_limit_kw:h_abc');
    expect(homeScopedSettingsKey('capacity_margin_kw', 'h_abc')).toBe('capacity_margin_kw:h_abc');
    expect(homeScopedSettingsKey('pels_status', 'h_abc')).toBe('pels_status:h_abc');
  });
});

describe('resolveHomeLimitsStatus boundary shaping', () => {
  it('resolves power now from managed + background when a live sample exists', () => {
    const status = resolveHomeLimitsStatus(
      { controlledKw: 2, uncontrolledKw: 1.4, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.powerNowKw).toBeCloseTo(3.4);
    expect(status.hardCapKw).toBe(8);
    expect(status.posture).toBe('active');
  });

  it('resolves power now from the whole-area total when per-device attribution is absent', () => {
    // A meter area can report a live total while controlledKw/uncontrolledKw are
    // omitted (no per-device power attribution). "Power now" must come from the
    // total, not read missing/zero.
    const status = resolveHomeLimitsStatus(
      { totalKw: 5.2, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.powerNowKw).toBeCloseTo(5.2);
  });

  it('prefers the area total over the parts sum, falling back to parts when the total is junk', () => {
    // Total present → used verbatim.
    expect(resolveHomeLimitsStatus(
      { totalKw: 6, controlledKw: 2, uncontrolledKw: 1, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    ).powerNowKw).toBeCloseTo(6);
    // Non-finite total → fall back to the controlled + background sum.
    expect(resolveHomeLimitsStatus(
      { totalKw: Number.POSITIVE_INFINITY, controlledKw: 2, uncontrolledKw: 1, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    ).powerNowKw).toBeCloseTo(3);
  });

  it('keeps the total unknown without a live sample (no confident draw)', () => {
    // A total is present but there is no live sample — Power now stays unknown.
    const status = resolveHomeLimitsStatus(
      { totalKw: 5.2, powerKnown: true, hasLivePowerSample: false, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.powerNowKw).toBeNull();
  });

  it('drops power to null without a live sample (never sums a partial reading)', () => {
    const status = resolveHomeLimitsStatus(
      { controlledKw: 2, uncontrolledKw: 1, powerKnown: true, hasLivePowerSample: false, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.hasStatus).toBe(true);
    expect(status.powerNowKw).toBeNull();
  });

  it('renders unknown (never "Infinity kW") when the power sum overflows to Infinity', () => {
    const status = resolveHomeLimitsStatus(
      {
        controlledKw: Number.MAX_VALUE, uncontrolledKw: Number.MAX_VALUE,
        powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none',
      },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.powerNowKw).toBeNull();
    expect(formatHomeLimitsKw(status.powerNowKw)).toBe('—');
  });

  it('gates a NaN power operand out of the resolved value (valid blob otherwise)', () => {
    const status = resolveHomeLimitsStatus(
      { controlledKw: Number.NaN, uncontrolledKw: 1, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none' },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.hasStatus).toBe(true);
    expect(status.powerNowKw).toBeNull();
    expect(status.limitedDeviceCount).toBe(0);
  });

  it('treats a missing blob as no status (posture + cap still resolve)', () => {
    const status = resolveHomeLimitsStatus(null, { dryRun: true, hardCapKw: 5 });
    expect(status.hasStatus).toBe(false);
    expect(status.posture).toBe('simulating');
    expect(status.hardCapKw).toBe(5);
    expect(status.limitedDeviceCount).toBeNull();
  });

  it('accepts a valid non-negative device count', () => {
    expect(resolveHomeLimitsStatus({ devicesOff: 2, limitReason: 'hourly' }, { dryRun: false, hardCapKw: 8 }).limitedDeviceCount).toBe(2);
    expect(resolveHomeLimitsStatus({ devicesOff: 0, limitReason: 'none' }, { dryRun: false, hardCapKw: 8 }).limitedDeviceCount).toBe(0);
  });

  it.each([
    ['empty object', {}],
    ['non-numeric devicesOff', { devicesOff: 'junk', limitReason: 'hourly' }],
    ['negative devicesOff', { devicesOff: -1, limitReason: 'hourly' }],
    ['fractional devicesOff', { devicesOff: 1.5, limitReason: 'hourly' }],
    ['non-finite devicesOff', { devicesOff: Number.POSITIVE_INFINITY, limitReason: 'hourly' }],
    ['unknown limitReason', { devicesOff: 1, limitReason: 'sideways' }],
    ['missing limitReason', { devicesOff: 1 }],
  ] as const)('renders pending/unknown when required fields are junk (%s)', (_label, blob) => {
    const status = resolveHomeLimitsStatus(blob, { dryRun: false, hardCapKw: 8 });
    // No confident "Within the cap." over garbage — fall back to the unknown state.
    expect(status.hasStatus).toBe(false);
    expect(status.limitedDeviceCount).toBeNull();
    expect(composeHomeLimitsStateLine(status)).toBe(HOME_LIMITS_STATUS_PENDING);
    // Posture + cap still come from the area's own settings, not the blob.
    expect(status.posture).toBe('active');
    expect(status.hardCapKw).toBe(8);
  });
});

describe('posture chip + state line copy', () => {
  it('chips Simulating (warn) vs Active (ok)', () => {
    const sim = resolveHomeLimitsStatus({}, { dryRun: true, hardCapKw: 8 });
    const active = resolveHomeLimitsStatus({}, { dryRun: false, hardCapKw: 8 });
    expect(resolveHomeLimitsPostureChip(sim)).toEqual({ label: 'Simulating', tone: 'warn' });
    expect(resolveHomeLimitsPostureChip(active)).toEqual({ label: 'Active', tone: 'ok' });
  });

  it('keeps the simulation state line hypothetical (would limit …)', () => {
    const line = composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'hourly', devicesOff: 2 }, { dryRun: true, hardCapKw: 8 }),
    );
    expect(line).toBe('Simulating — would limit 2 devices.');
  });

  it('renders the pending line when no blob has arrived', () => {
    expect(composeHomeLimitsStateLine(resolveHomeLimitsStatus(null, { dryRun: false, hardCapKw: 8 })))
      .toBe(HOME_LIMITS_STATUS_PENDING);
  });

  it('names the shortfall consequence over the limiting count when active', () => {
    const line = composeHomeLimitsStateLine(
      resolveHomeLimitsStatus(
        { limitReason: 'hourly', devicesOff: 3, capacityShortfall: true, powerKnown: true, hasLivePowerSample: true, controlledKw: 1, uncontrolledKw: 1 },
        { dryRun: false, hardCapKw: 8 },
      ),
    );
    expect(line).toBe(HOME_LIMITS_STATUS_SHORTFALL);
  });

  it('reports limiting with a device count when active and over pace', () => {
    const line = composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'hourly', devicesOff: 1 }, { dryRun: false, hardCapKw: 8 }),
    );
    expect(line).toBe('Limiting 1 device to stay under the cap.');
  });

  it('names the cap only for a capacity-driven reason (hourly / both)', () => {
    expect(composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'both', devicesOff: 2 }, { dryRun: false, hardCapKw: 8 }),
    )).toBe('Limiting 2 devices to stay under the cap.');
  });

  it('does NOT blame the cap for transient holds (devicesOff>0 + limitReason none)', () => {
    // Restore-cooldown / meter-settling / restore-pending / startup holds count
    // in devicesOff but the producer marks them limitReason 'none' — honest copy
    // must not read "Limiting … to stay under the cap."
    const line = composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'none', devicesOff: 2 }, { dryRun: false, hardCapKw: 8 }),
    );
    expect(line).toBe('Holding 2 devices for a moment — resuming shortly.');
    expect(line).not.toContain('under the cap');
  });

  it('names the daily budget for a daily-limit reason', () => {
    expect(composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'daily', devicesOff: 1 }, { dryRun: false, hardCapKw: 8 }),
    )).toBe('Limiting 1 device to stay within today’s daily budget.');
  });

  it('keeps simulation idle for a transient hold, would-limit only for a real reason', () => {
    expect(composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'none', devicesOff: 3 }, { dryRun: true, hardCapKw: 8 }),
    )).toBe(HOME_LIMITS_STATUS_SIMULATING_IDLE);
    expect(composeHomeLimitsStateLine(
      resolveHomeLimitsStatus({ limitReason: 'hourly', devicesOff: 3 }, { dryRun: true, hardCapKw: 8 }),
    )).toBe('Simulating — would limit 3 devices.');
  });

  it('confirms the calm active + simulating idle lines', () => {
    expect(composeHomeLimitsStateLine(resolveHomeLimitsStatus(
      { limitReason: 'none', devicesOff: 0, powerKnown: true, hasLivePowerSample: true, controlledKw: 1, uncontrolledKw: 1 },
      { dryRun: false, hardCapKw: 8 },
    ))).toBe(HOME_LIMITS_STATUS_ACTIVE_IDLE);
    expect(composeHomeLimitsStateLine(resolveHomeLimitsStatus({ limitReason: 'none', devicesOff: 0 }, { dryRun: true, hardCapKw: 8 })))
      .toBe(HOME_LIMITS_STATUS_SIMULATING_IDLE);
  });

  it('withholds the "within the cap" claim when no live power reading exists (powerKnown false)', () => {
    // A blob can be well-formed (device count + reason) yet carry no current
    // draw. PELS must not assert compliance without a reading — codex P2.
    const line = composeHomeLimitsStateLine(resolveHomeLimitsStatus(
      { limitReason: 'none', devicesOff: 0, powerKnown: false, hasLivePowerSample: false },
      { dryRun: false, hardCapKw: 8 },
    ));
    expect(line).toBe(HOME_LIMITS_STATUS_AWAITING_READING);
    expect(line).not.toContain('Within the cap');
  });
});

describe('effective dry-run posture from the blob (R7b)', () => {
  it('shows Simulating when the blob is persisted-live but effective dry-run (no committed zone tree)', () => {
    // Persisted intent is live (dryRun false), but the runtime reports the
    // EFFECTIVE dry-run is still on (membership not ready) — the chip must be
    // honest and read Simulating, not Active.
    const status = resolveHomeLimitsStatus(
      { limitReason: 'none', devicesOff: 0, dryRunEffective: true },
      { dryRun: false, hardCapKw: 8 },
    );
    expect(status.posture).toBe('simulating');
    expect(resolveHomeLimitsPostureChip(status)).toEqual({ label: 'Simulating', tone: 'warn' });
  });

  it('shows Active when the blob confirms effective live control', () => {
    const status = resolveHomeLimitsStatus(
      { limitReason: 'none', devicesOff: 0, dryRunEffective: false, powerKnown: true, hasLivePowerSample: true, controlledKw: 1, uncontrolledKw: 1 },
      { dryRun: true, hardCapKw: 8 },
    );
    expect(status.posture).toBe('active');
  });

  it('falls back to the persisted dry-run when the blob predates the field', () => {
    expect(resolveHomeLimitsStatus({ limitReason: 'none', devicesOff: 0 }, { dryRun: true, hardCapKw: 8 }).posture)
      .toBe('simulating');
    expect(resolveHomeLimitsStatus(null, { dryRun: false, hardCapKw: 8 }).posture).toBe('active');
  });
});

describe('formatting + notice', () => {
  it('formats a kW figure to one decimal, dash when unknown', () => {
    expect(formatHomeLimitsKw(3.42)).toBe('3.4 kW');
    expect(formatHomeLimitsKw(null)).toBe('—');
  });

  it('names the meter area in the simulation activation notice (positive remedy)', () => {
    const notice = composeHomeLimitsSimulationNotice('Utleie');
    expect(notice).toContain('only simulating “Utleie”');
    // The remedy names the positive toggle, not "turn OFF simulation".
    expect(notice).toContain('turn on control to let it limit devices');
  });
});
