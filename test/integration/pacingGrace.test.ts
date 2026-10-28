import { NO_STORAGE_SHED_TERM, type StorageShedTerm } from '../../lib/plan/shedding/types';
import { CapacityDrainStart } from '../../lib/plan/capacityDrainStart';
import { computeDynamicSoftLimit, resolveShortfallThresholdKw } from '../../lib/plan/planBudget';
import { PacingGrace } from '../../lib/plan/pacingGrace';
import { buildPlanContext, buildPlanLimits, resolveMeasuredPower } from '../../lib/plan/planContext';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildPlanInputDevice } from '../utils/planTestUtils';

const START_MS = Date.UTC(2026, 0, 15, 12);

/** One synthetic home; all context and power axes use their production producers. */
class GraceHome {
  readonly grace = new PacingGrace();

  settings: PowerLimitSettings = {
    capacityEnabled: true, limitKw: 10, marginKw: 0.2, periodMinutes: 60, gridImportLimitKw: null,
  };

  powerKw = 0;

  managedKw = 6;

  dailyPaceKw: number | null = 7;

  usedKWh = 0;

  storage: StorageShedTerm = NO_STORAGE_SHED_TERM;

  read(atMs: number, readingAtMs = atMs) {
    const devices = [buildPlanInputDevice({ id: 'load', currentDrawKw: this.managedKw })];
    const quarterStartMs = Math.floor(atMs / 900_000) * 900_000;
    const tracker: PowerTrackerState = {
      lastTimestamp: readingAtMs, lastPowerW: this.powerKw * 1000,
      buckets: { [new Date(Math.floor(atMs / 3_600_000) * 3_600_000).toISOString()]: this.usedKWh },
      capacityQuarter: { startMs: quarterStartMs, energyKWh: this.usedKWh, trackedMs: atMs - quarterStartMs },
    };
    const daily = this.dailyPaceKw === null ? null : {
      dailySoftLimitKw: this.dailyPaceKw, budgetPaceKw: this.dailyPaceKw, projectedExemptKw: 0,
    };
    const drain = new CapacityDrainStart();
    const pace = computeDynamicSoftLimit(this.settings, tracker, atMs, drain.startFor(this.settings, tracker, atMs));
    const context = buildPlanContext(
      devices, this.settings, tracker,
      buildPlanLimits(this.settings, this.settings.capacityEnabled ? pace.allowedKw : null, daily),
      new Map(), atMs,
    );
    const power = resolveMeasuredPower({
      isMeasured: true, totalKw: this.powerKw, lastPowerUpdateMs: readingAtMs,
      headroomKw: (limitKw) => limitKw - this.powerKw,
    }, context, devices);
    return this.grace.decide(context, power, this.settings, this.storage,
      resolveShortfallThresholdKw(this.settings, tracker, atMs), {
      atMs: readingAtMs, powerW: this.powerKw * 1000,
    });
  }

  /** Observe a real period boundary and ordinary 10-second cadence before pressure. */
  prime() {
    this.read(START_MS - 20_000);
    this.read(START_MS - 10_000);
    this.read(START_MS);
    this.powerKw = 8;
    return this;
  }
}

describe('period-funded pressure patience', () => {
  it('waits for background-driven capacity pressure without an activation attempt', () => {
    const home = new GraceHome().prime();
    home.dailyPaceKw = null;
    home.powerKw = 9.9;
    expect(home.read(START_MS + 10_000)).toEqual({
      actionable: true, shedActionable: false, pendingSinceMs: START_MS + 10_000,
    });
    home.powerKw = 6;
    expect(home.read(START_MS + 20_000).actionable).toBe(false);
  });

  it('spends 100 Wh for a 6 kW wait in an hourly 0.2 kW margin, retaining the other 100 Wh', () => {
    const home = new GraceHome().prime();
    for (let second = 10; second <= 60; second += 10) {
      expect(home.read(START_MS + second * 1000).shedActionable).toBe(false);
    }
    expect(home.read(START_MS + 70_000).shedActionable).toBe(true);
    home.powerKw = 0;
    home.read(START_MS + 80_000);
    home.powerKw = 8;
    expect(home.read(START_MS + 90_000).shedActionable).toBe(true);
  });

  it('scales the allowance to 25 Wh per quarter instead of allowing an hourly minute', () => {
    const home = new GraceHome();
    home.settings.periodMinutes = 15;
    home.prime();
    expect(home.read(START_MS + 10_000).shedActionable).toBe(false);
    expect(home.read(START_MS + 20_000).shedActionable).toBe(true);
  });

  it('requires enough allowance for an entire observed interval before waiting', () => {
    const home = new GraceHome();
    home.settings.periodMinutes = 15;
    home.prime();
    expect(home.read(START_MS + 30_000).shedActionable).toBe(true);
  });

  it.each([1000, 10_000])('preserves response reserve when the projection already occupies the margin (%i ms cadence)', (cadenceMs) => {
    const home = new GraceHome();
    home.settings.periodMinutes = 15;
    home.prime();
    home.powerKw = 0;
    home.read(START_MS + 720_000 - cadenceMs);
    home.powerKw = 9.9;
    home.usedKWh = 2;
    // Only 5 Wh of projection spare remains: even a 1 s wait may not spend the
    // 25 Wh protected response reserve from the configured 50 Wh quarter margin.
    expect(home.read(START_MS + 720_000).shedActionable).toBe(true);
  });

  it('shares one allowance across separate pressure episodes', () => {
    const home = new GraceHome().prime();
    for (let episode = 0; episode < 3; episode += 1) {
      const offset = episode * 40_000;
      expect(home.read(START_MS + offset + 10_000).shedActionable).toBe(false);
      expect(home.read(START_MS + offset + 20_000).shedActionable).toBe(false);
      home.powerKw = 0;
      home.read(START_MS + offset + 30_000);
      home.read(START_MS + offset + 40_000);
      home.powerKw = 8;
    }
    expect(home.read(START_MS + 130_000).shedActionable).toBe(true);
  });

  it('charges the preceding wait even when the new reading is urgent or clear', () => {
    const home = new GraceHome();
    home.settings.periodMinutes = 15;
    home.prime();
    expect(home.read(START_MS + 10_000).shedActionable).toBe(false);
    home.powerKw = 12;
    expect(home.read(START_MS + 20_000).shedActionable).toBe(true);
    home.powerKw = 0;
    home.read(START_MS + 30_000);
    home.powerKw = 8;
    expect(home.read(START_MS + 40_000).shedActionable).toBe(true);
  });

  it('charges observed increases conservatively and refuses further waiting after a late reading', () => {
    const home = new GraceHome().prime();
    expect(home.read(START_MS + 10_000).shedActionable).toBe(false);
    home.powerKw = 14;
    home.managedKw = 12;
    expect(home.read(START_MS + 40_000).shedActionable).toBe(true);
    home.powerKw = 0;
    home.read(START_MS + 50_000);
    home.powerKw = 8;
    home.managedKw = 6;
    expect(home.read(START_MS + 60_000).shedActionable).toBe(true);
  });

  it('does not charge duplicate builds twice or restart the episode deadline', () => {
    const home = new GraceHome().prime();
    const first = home.read(START_MS + 10_000);
    expect(home.read(START_MS + 20_000, START_MS + 10_000).pendingSinceMs).toBe(first.pendingSinceMs);
    for (let second = 20; second <= 60; second += 10) {
      expect(home.read(START_MS + second * 1000).shedActionable).toBe(false);
    }
    expect(home.read(START_MS + 70_000, START_MS + 60_000).shedActionable).toBe(true);
  });

  it('does not grant capacity grace in the first partial period after restart', () => {
    const home = new GraceHome();
    home.powerKw = 8;
    expect(home.read(START_MS + 10_000).shedActionable).toBe(true);
    expect(home.read(START_MS + 20_000).shedActionable).toBe(true);
  });

  it('cancels the period allowance when accepted sample time moves backwards', () => {
    const home = new GraceHome().prime();
    expect(home.read(START_MS + 10_000).shedActionable).toBe(false);
    expect(home.read(START_MS + 5000).shedActionable).toBe(true);
    home.powerKw = 0;
    home.read(START_MS + 20_000);
    home.powerKw = 8;
    expect(home.read(START_MS + 30_000).shedActionable).toBe(true);
  });

  it('keeps existing rounding-noise dwell outside the discretionary allowance', () => {
    const home = new GraceHome().prime();
    for (let second = 10; second <= 200; second += 20) {
      home.powerKw = 7.01;
      expect(home.read(START_MS + second * 1000).actionable).toBe(false);
      home.powerKw = 0;
      home.read(START_MS + (second + 10) * 1000);
    }
    home.powerKw = 8;
    for (let second = 210; second <= 260; second += 10) {
      expect(home.read(START_MS + second * 1000).shedActionable).toBe(false);
    }
    expect(home.read(START_MS + 270_000).shedActionable).toBe(true);
  });

  it('has no discretionary capacity allowance with a zero margin', () => {
    const home = new GraceHome();
    home.settings.marginKw = 0;
    home.dailyPaceKw = 6;
    home.prime();
    expect(home.read(START_MS + 10_000).shedActionable).toBe(true);
  });

  it('does not price a known battery hand-back from its smaller pre-release import', () => {
    const home = new GraceHome().prime();
    home.powerKw = 2;
    home.storage = { ...NO_STORAGE_SHED_TERM, netCreditKw: -6 };
    expect(home.read(START_MS + 10_000).shedActionable).toBe(true);
  });

  it('does not mint a quarter allowance through a settings rebuild on an old hourly sample', () => {
    const home = new GraceHome().prime();
    home.powerKw = 0;
    home.read(START_MS + 10_000);
    home.settings.periodMinutes = 15;
    home.powerKw = 8;
    expect(home.read(START_MS + 20_000, START_MS + 10_000).shedActionable).toBe(true);
  });

  it('requires a reading in the new period to open its allowance', () => {
    const home = new GraceHome();
    home.read(START_MS - 20_000);
    home.read(START_MS - 10_000);
    home.read(START_MS, START_MS - 10_000);
    home.powerKw = 8;
    expect(home.read(START_MS + 10_000).shedActionable).toBe(false);
  });

  it('does not replenish expenditure by toggling capacity or changing its margin', () => {
    const home = new GraceHome();
    home.settings.periodMinutes = 15;
    home.prime();
    home.read(START_MS + 10_000);
    home.read(START_MS + 20_000);
    home.powerKw = 0;
    home.settings.capacityEnabled = false;
    home.read(START_MS + 30_000);
    home.settings.capacityEnabled = true;
    home.settings.marginKw = 0.1;
    home.read(START_MS + 40_000);
    home.powerKw = 8;
    expect(home.read(START_MS + 50_000).shedActionable).toBe(true);
  });

  it('withdraws patience for grid pressure, actual-cap pressure and an exhausted period', () => {
    const home = new GraceHome().prime();
    home.settings.gridImportLimitKw = 8;
    expect(home.read(START_MS + 10_000).shedActionable).toBe(true);
    home.settings.gridImportLimitKw = null;
    home.powerKw = 0;
    home.read(START_MS + 20_000);
    home.powerKw = 8;
    home.powerKw = 12;
    expect(home.read(START_MS + 30_000).shedActionable).toBe(true);
    home.powerKw = 0;
    home.read(START_MS + 40_000);
    home.powerKw = 8;
    home.usedKWh = 9.8;
    expect(home.read(START_MS + 50_000).shedActionable).toBe(true);
  });

  it('does not defer the hourly drain or a quarter boundary', () => {
    const hour = new GraceHome().prime();
    hour.powerKw = 0;
    hour.read(START_MS + 2_990_000);
    hour.powerKw = 8;
    expect(hour.read(START_MS + 3_000_000).shedActionable).toBe(true);
    const quarter = new GraceHome();
    quarter.settings.periodMinutes = 15;
    quarter.prime();
    quarter.powerKw = 0;
    quarter.read(START_MS + 830_000);
    quarter.powerKw = 8;
    expect(quarter.read(START_MS + 840_000).shedActionable).toBe(true);
  });

  it('keeps daily-only patience when capacity is disabled, with grid urgency still immediate', () => {
    const home = new GraceHome();
    home.settings.capacityEnabled = false;
    home.dailyPaceKw = 6;
    home.powerKw = 8;
    expect(home.read(START_MS).shedActionable).toBe(false);
    expect(home.read(START_MS + 60_000).shedActionable).toBe(true);
    home.settings.gridImportLimitKw = 8;
    expect(home.read(START_MS + 70_000).shedActionable).toBe(true);
  });
});
