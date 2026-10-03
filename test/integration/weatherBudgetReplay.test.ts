import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';

it('uses its own budget on partial-temperature days before folding the next day', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pels-budget-replay-'));
  try {
    const history = JSON.parse(
      readFileSync(resolve('test/fixtures/weatherHistoryProduction.json'), 'utf8'),
    ) as { records: WeatherDailyRecord[] };
    const partialDay = history.records.at(-1)!;
    partialDay.quality.partialTemp = true;
    history.records.push({
      ...partialDay, dateKey: '2026-08-01', appliedBudgetKwh: 50,
      quality: { ...partialDay.quality, partialTemp: false },
    });
    const logPath = join(directory, 'forecasts.log');
    writeFileSync(logPath, '');
    const replay = (recordedBudgetKwh: number) => {
      partialDay.appliedBudgetKwh = recordedBudgetKwh;
      const historyPath = join(directory, 'history.json');
      const outputPath = join(directory, 'replay.json');
      writeFileSync(historyPath, JSON.stringify(history));
      execFileSync(process.execPath, [resolve('scripts/replay-weather-budget.mjs'),
        historyPath, logPath, outputPath, 'Europe/Oslo', '4.7'], { stdio: 'pipe' });
      return JSON.parse(readFileSync(outputPath, 'utf8')) as {
        rows: Array<{ dateKey: string; revisedKwh: number; conservativeKwh: number }>;
      };
    };
    const tight = replay(44);
    const roomy = replay(200);
    expect(tight.rows.map((row) => row.dateKey)).not.toContain(partialDay.dateKey);
    const nextDay = (report: ReturnType<typeof replay>) => report.rows.find((row) => row.dateKey === '2026-08-01');
    expect(nextDay(tight)).toBeDefined();
    // The recorded allowance is a baseline comparator, never the allowance
    // governing feedback once a counterfactual recommendation is available.
    expect(nextDay(tight)).toEqual(nextDay(roomy));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
