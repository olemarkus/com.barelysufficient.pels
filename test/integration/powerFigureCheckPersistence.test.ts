import { describe, expect, it, onTestFinished } from 'vitest';
import { createPowerFigureChecks } from '../../lib/device/powerFigureCheck';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

const heater = {
  id: 'heater', expectedPowerKw: 2.6, expectedPowerSource: 'measured-peak' as const,
  isEvCharger: false, isBatteryOrSolar: false,
};

/**
 * The home meter's falls on the real repository over an in-memory userdata
 * database: what one run records, the next run reads. The check's policy is
 * unit-tested in `powerFigureCheck.test.ts`.
 */
describe('power figure check persistence', () => {
  it('reads the falls an earlier run recorded', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    onTestFinished(() => db.close());
    const powerState = { expectedPowerKwOverrides: {}, lastKnownPowerKw: {} };
    const firstRun = createPowerFigureChecks(() => db, () => powerState);
    for (const [index, fallKw] of [4.4, 4.5, 4.45, 4.5, 4.48].entries()) {
      firstRun.recordSoleSwitchOffFall({ deviceId: 'heater', decidedAtMs: NOW - (index + 1) * 3_600_000, fallKw });
    }

    const nextRun = createPowerFigureChecks(() => db, () => powerState);
    expect(nextRun.read(heater, NOW)).toEqual({
      measuredKw: 4.48, figureKw: 2.6, figure: 'device_reading',
    });
  });
});
