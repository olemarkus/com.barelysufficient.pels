import { readFileSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle the actual production functions, so replay cannot drift into a second algorithm.
const compiled = buildSync({
  stdin: {
    contents: `
      export { fitEnergySignature, isUsableSignatureDay } from '../packages/shared-domain/src/energySignature/energySignature';
      export { foldBudgetPressureDay } from '../packages/shared-domain/src/energySignature/budgetPressure';
      export { getDateKeyStartMs, getNextLocalDayStartUtcMs } from '../packages/shared-domain/src/utils/dateUtils';
      export { suggestDailyBudgetKwh } from '../lib/weather/suggestDailyBudget';
      export { normalizeWeatherHistoryState } from '../lib/weather/weatherHistory';
      export { resolvePersistenceMeanTempC } from '../lib/weather/energySignatureService';
    `,
    resolveDir: dirname(fileURLToPath(import.meta.url)),
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
}).outputFiles[0].text;
const {
  fitEnergySignature, isUsableSignatureDay, foldBudgetPressureDay,
  getDateKeyStartMs, getNextLocalDayStartUtcMs, suggestDailyBudgetKwh,
  normalizeWeatherHistoryState, resolvePersistenceMeanTempC,
} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const [historyPath, logPath, outputPath, timeZone, capacityArg] = process.argv.slice(2);
if (!historyPath || !logPath || !outputPath || !timeZone || !capacityArg) {
  throw new Error("Usage: replay-weather-budget HISTORY_JSON LOG_PATH OUTPUT_JSON TIME_ZONE CAPACITY_KW");
}
const capacityKw = Number(capacityArg);
if (!Number.isFinite(capacityKw) || capacityKw <= 0) throw new Error("Capacity must be a finite positive kW value");
const history = normalizeWeatherHistoryState(JSON.parse(readFileSync(historyPath, "utf8")));
if (!history) throw new Error("History export has no readable daily records");
const records = history.records;
const forecasts = new Map();
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  const brace = line.indexOf("{");
  if (brace < 0 || !line.includes('"event":"weather_advisor_fit"')) continue;
  const event = JSON.parse(line.slice(brace));
  if (!event.targetDateKey || event.forecastSource !== "met_api" || !Number.isFinite(event.forecastMeanTempC)) continue;
  const recordedAtMs = Date.parse(line.slice(0, 24));
  const start = getDateKeyStartMs(event.targetDateKey, timeZone);
  if (recordedAtMs < start || recordedAtMs > start + 15 * 6e4) continue;
  const previous = forecasts.get(event.targetDateKey);
  if (!previous || recordedAtMs < previous.recordedAtMs) {
    forecasts.set(event.targetDateKey, { tempC: event.forecastMeanTempC, recordedAtMs });
  }
}
const rows = [];
let pressure;
let conservativePressure;
const prior = [];
const conservativePrior = [];
for (const record of records) {
  const archived = forecasts.get(record.dateKey);
  const fallback = resolvePersistenceMeanTempC({ records: prior });
  const forecast = record.appliedBudgetKwh !== void 0 ? archived ?? (fallback === void 0 ? void 0 : { tempC: fallback, recordedAtMs: 0 }) : void 0;
  const start = getDateKeyStartMs(record.dateKey, timeZone);
  const dayHours = (getNextLocalDayStartUtcMs(start, timeZone) - start) / 36e5;
  const fit = forecast ? fitEnergySignature(prior, start) : null;
  const conservativeFit = forecast ? fitEnergySignature(conservativePrior, start) : null;
  let revisedBudget;
  let conservativeBudget;
  if (forecast && fit && conservativeFit && record.appliedBudgetKwh !== void 0) {
    revisedBudget = suggestDailyBudgetKwh({
      fit,
      targetDateKey: record.dateKey,
      forecastMeanTempC: forecast.tempC,
      capacityLimitKw: capacityKw,
      capacityDayHours: dayHours,
      budgetPressure: pressure
    }).suggestedBudgetKwh;
    conservativeBudget = suggestDailyBudgetKwh({
      fit: conservativeFit,
      targetDateKey: record.dateKey,
      forecastMeanTempC: forecast.tempC,
      capacityLimitKw: capacityKw,
      capacityDayHours: dayHours,
      budgetPressure: conservativePressure
    }).suggestedBudgetKwh;
    if (isUsableSignatureDay(record)) rows.push({
      dateKey: record.dateKey,
      actualKwh: record.kwhTotal,
      appliedKwh: record.appliedBudgetKwh,
      revisedKwh: revisedBudget,
      conservativeKwh: conservativeBudget,
      forecastTempC: forecast.tempC,
      trainingDays: fit.usableDays,
      forecastSource: archived ? "archived_met" : "prior_week_fallback"
    });
  }
  // Exports from before budget-counted usage was recorded carry only the
  // whole-home total; replay those as if no load was budget-exempt.
  const counted = record.kwhBudgetCounted ?? record.kwhTotal;
  const observed = {
    ...record,
    kwhBudgetCounted: counted,
    appliedBudgetKwh: revisedBudget ?? record.appliedBudgetKwh
  };
  const conservative = {
    ...record,
    kwhBudgetCounted: counted,
    appliedBudgetKwh: conservativeBudget ?? record.appliedBudgetKwh,
    suppression: {
      ...record.suppression,
      budgetUnservedKwh: record.suppression?.budgetDeniedKwh ?? record.suppression?.budgetUnservedKwh ?? 0
    }
  };
  pressure = foldBudgetPressureDay(pressure, observed, capacityKw * dayHours);
  conservativePressure = foldBudgetPressureDay(conservativePressure, conservative, capacityKw * dayHours);
  prior.push(observed);
  conservativePrior.push(conservative);
}
function metrics(selected, key) {
  const n = selected.length;
  const sum = (get) => selected.reduce((total, row) => total + get(row), 0);
  return {
    days: n,
    meanActualKwh: sum((row) => row.actualKwh) / n,
    meanBudgetKwh: sum((row) => row[key]) / n,
    meanAbsoluteErrorKwh: sum((row) => Math.abs(row[key] - row.actualKwh)) / n,
    meanUnusedKwh: sum((row) => Math.max(0, row[key] - row.actualKwh)) / n,
    belowActualDays: selected.filter((row) => row[key] < row.actualKwh).length,
    totalBelowActualKwh: sum((row) => Math.max(0, row.actualKwh - row[key]))
  };
}
const summary = (selected) => ({
  applied: metrics(selected, "appliedKwh"),
  revised: metrics(selected, "revisedKwh"),
  conservative: metrics(selected, "conservativeKwh")
});
const report = {
  methodology: {
    training: "Only records strictly before each target date; refit separately each day.",
    forecasts: "Earliest archived MET forecast during first 15 minutes of target day; other days use production prior-week fallback, reported separately.",
    missingEvidence: "Historical holds cannot prove recovery/cause. Conservative replay treats all cumulative holds as unresolved budget denial.",
    limitation: "Recorded usage and holds remain fixed; this does not simulate device delivery or prove tighter budgets serve demand.",
    budgetCountedUsage: "Records without budget-counted usage are replayed on whole-home kWh, which overstates overshoot on homes with budget-exempt devices.",
    timeZone,
    capacityKw
  },
  all: summary(rows),
  archivedForecasts: summary(rows.filter((row) => row.forecastSource === "archived_met")),
  fallbackForecasts: summary(rows.filter((row) => row.forecastSource === "prior_week_fallback")),
  recent: summary(rows.filter((row) => row.dateKey >= "2026-09-22")),
  ceilingPeriod: summary(rows.filter((row) => row.dateKey >= "2026-09-29")),
  skippedForecastDates: records.filter((record) => record.appliedBudgetKwh !== void 0 && !forecasts.has(record.dateKey)).map((record) => record.dateKey),
  rows
};
writeFileSync(outputPath, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ all: report.all, archivedForecasts: report.archivedForecasts, ceilingPeriod: report.ceilingPeriod }, null, 2)}
`);
