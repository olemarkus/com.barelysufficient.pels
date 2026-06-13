// User-facing copy + number formatting for the hidden "Weather insight"
// surface (Budget Tomorrow card, detail view, Settings pickers).
//
// Lives in shared-domain so the settings UI and any future runtime logging
// speak the same words for the same signal (`feedback_ui_text_shared_with_logs`).
// Import this module DIRECTLY — there is no shared-domain barrel.
//
// Copy spec of record: `notes/weather-insight-spec.md` (S1–S8 states,
// formatting-rules table, marker grammar). Vocabulary rules:
// no "model/regression/R²/HDD" anywhere; confidence is words (`Estimating` /
// `Refining` / silence) reusing the smart-task vocabulary; remedies name the
// daily budget, never the hard cap.

import type {
  EnergySignatureConfidence,
  WeatherCoverageBin,
  WeatherDeviceReading,
  WeatherForecastStatus,
} from '../../contracts/src/weatherAdvisorTypes';

// U+2212 minus (repo convention for negative numbers in UI copy).
const MINUS = '−';

const signed = (value: number, formatted: string): string => (
  value < 0 ? `${MINUS}${formatted}` : formatted
);

/** Whole number at ≥ 10 kWh, one decimal below (`47 kWh`, `8.5 kWh`). */
export const formatDailyKwh = (value: number): string => {
  const abs = Math.abs(value);
  const text = abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
  return `${signed(value, text)} kWh`;
};

/** Expected range, whole kWh with an en dash (`41–52 kWh`). */
export const formatKwhRange = (lowKwh: number, highKwh: number): string => (
  `${Math.round(lowKwh)}–${Math.round(highKwh)} kWh`
);

/** Per-degree extra, one decimal with a leading `+` (`+1.8 kWh/day`). */
export const formatPerDegree = (kwhPerDegree: number): string => (
  `+${Math.abs(kwhPerDegree).toFixed(1)} kWh/day`
);

/** Whole °C (`2 °C`, `−8 °C`). */
export const formatTempC = (value: number): string => {
  const rounded = Math.round(value);
  return `${signed(rounded, String(Math.abs(rounded)))} °C`;
};

/** Approximate temperature (`≈ 13 °C`). */
export const formatApproxTempC = (value: number): string => `≈ ${formatTempC(value)}`;

/** Heat loss to the nearest 10 W (`≈ 150 W per °C`). */
export const formatHeatLossW = (wPerK: number): string => (
  `≈ ${Math.round(wPerK / 10) * 10} W per °C`
);

const formatDays = (days: number): string => (days === 1 ? '1 day' : `${days} days`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-03-12` → `12 Mar` (scatter dot tooltips). */
export const formatTooltipDate = (dateKey: string): string => {
  const month = Number.parseInt(dateKey.slice(5, 7), 10);
  const day = Number.parseInt(dateKey.slice(8, 10), 10);
  if (!Number.isFinite(month) || !Number.isFinite(day) || month < 1 || month > 12) return dateKey;
  return `${day} ${MONTHS[month - 1]}`;
};

// ── Feature naming + chips ─────────────────────────────────────────────────

export const WEATHER_INSIGHT_TITLE = 'Weather insight';
export const WEATHER_CHIP_ROUGH_ESTIMATE = 'Rough estimate';

/** Smart-task confidence vocabulary: low → Estimating, medium → Refining, high → no chip. */
export const resolveWeatherConfidenceChip = (
  confidence: EnergySignatureConfidence,
): string | null => {
  if (confidence === 'low') return 'Estimating';
  if (confidence === 'medium') return 'Refining';
  return null;
};

// ── Tomorrow card (Budget plan view) ───────────────────────────────────────

export const composeTomorrowTitle = (tempC: number): string => (
  `Tomorrow: around ${formatTempC(tempC)}`
);

export const WEATHER_SOURCE_FORECAST = 'Forecast for tomorrow’s average';
export const WEATHER_SOURCE_PERSISTENCE = 'If recent weather continues — no forecast device set.';
/** A forecast device IS configured but isn't reporting tomorrow's temperature. */
export const WEATHER_SOURCE_FORECAST_UNREADABLE = 'Forecast device isn’t reporting tomorrow’s '
  + 'temperature — using recent days.';

/** Maps the producer-resolved forecast provenance to the Tomorrow-card source line. */
export const composeForecastSourceLine = (status: WeatherForecastStatus): string => {
  if (status === 'forecast') return WEATHER_SOURCE_FORECAST;
  if (status === 'recent_device_unreadable') return WEATHER_SOURCE_FORECAST_UNREADABLE;
  return WEATHER_SOURCE_PERSISTENCE;
};

export const WEATHER_ROW_EXPECTED_USAGE = 'Expected usage';
export const WEATHER_ROW_SUGGESTED_BUDGET = 'Suggested daily budget';
export const WEATHER_ROW_YOUR_BUDGET = 'Your daily budget';
/** S5: the expected range comes from recent days, not a temperature estimate. */
export const WEATHER_EXPECTED_FROM_RECENT_DAYS = 'Based on your recent days.';

export const WEATHER_BUTTON_ADJUST_BUDGET = 'Adjust budget';
export const WEATHER_BUTTON_DETAILS = 'Weather details';

export const WEATHER_REASON_COLDER_THAN_OBSERVED = 'Tomorrow looks colder than any day PELS has '
  + 'measured — the range is wider than usual.';
export const WEATHER_REASON_DRIFT_WIDER = 'Recent days ran higher than usual, so the range is wider.';
export const WEATHER_REASON_BUDGET_LIMITING = 'Recent cold days were limited by your budget — '
  + 'the suggestion is raised to match.';

export type WeatherVerdictTone = 'ok' | 'warn';
export type WeatherTomorrowVerdict = { text: string; tone: WeatherVerdictTone };

export const WEATHER_VERDICT_COVERS_WITH_ROOM = 'Your budget covers tomorrow with room to spare.';
export const WEATHER_VERDICT_SHOULD_COVER = 'Your budget should cover tomorrow.';
export const WEATHER_VERDICT_MAY_BE_TIGHT = 'Tomorrow may be tight — a cold evening could use the whole budget.';
export const WEATHER_VERDICT_LIKELY_SHORT = 'Tomorrow likely needs more than your budget. '
  + 'PELS will hold managed devices back to stay inside it.';

/**
 * Verdict ladder: the active daily budget vs tomorrow's prediction quantiles
 * (q50/q80/q90 = prediction + residual quantiles). Null when no daily budget
 * is set — the card then shows the numbers without a judgment.
 */
export const resolveTomorrowVerdict = (params: {
  currentDailyBudgetKwh: number | null;
  predictionKwh: number;
  residualQ50: number;
  residualQ80: number;
  residualQ90: number;
}): WeatherTomorrowVerdict | null => {
  const { currentDailyBudgetKwh, predictionKwh, residualQ50, residualQ80, residualQ90 } = params;
  if (currentDailyBudgetKwh === null || !Number.isFinite(currentDailyBudgetKwh)) return null;
  if (currentDailyBudgetKwh >= predictionKwh + residualQ90) {
    return { text: WEATHER_VERDICT_COVERS_WITH_ROOM, tone: 'ok' };
  }
  if (currentDailyBudgetKwh >= predictionKwh + residualQ80) {
    return { text: WEATHER_VERDICT_SHOULD_COVER, tone: 'ok' };
  }
  if (currentDailyBudgetKwh >= predictionKwh + residualQ50) {
    return { text: WEATHER_VERDICT_MAY_BE_TIGHT, tone: 'warn' };
  }
  return { text: WEATHER_VERDICT_LIKELY_SHORT, tone: 'warn' };
};

// ── Detail view: summary card ──────────────────────────────────────────────

/** Ready-state headline — the whole feature in one breath. */
export const composeSummaryHeadline = (params: {
  baseLoadKwhPerDay: number;
  slopeKwhPerDegree: number;
  balancePointC: number;
}): string => (
  `Your home uses about ${formatDailyKwh(params.baseLoadKwhPerDay)} on a warm day, `
  + `and about ${Math.abs(params.slopeKwhPerDegree).toFixed(1)} kWh more for each degree below `
  + `${formatApproxTempC(params.balancePointC)}.`
);

/** S4 winter-only headline — anchored at 0 °C, no balance point claimed. */
export const composeWinterOnlyHeadline = (params: {
  kwhAtZeroC: number;
  slopeKwhPerDegree: number;
}): string => (
  `On a day around 0 °C your home uses about ${formatDailyKwh(params.kwhAtZeroC)}, `
  + `and about ${Math.abs(params.slopeKwhPerDegree).toFixed(1)} kWh more for each degree colder.`
);

/** S5 uncorrelated — a valid, honest outcome, not a failure. */
export const composeUncorrelatedSummary = (usableDays: number): string => (
  `Your usage doesn’t follow the weather. Across ${formatDays(usableDays)}, colder days don’t use `
  + 'noticeably more energy — normal for homes without electric heating.'
);

export const composeBasedOnDays = (usableDays: number): string => (
  `Based on ${formatDays(usableDays)} over the last year.`
);

/**
 * Yesterday vs typical-for-its-temperature. Deviation inside the typical band
 * (residual q10..q90) reads as "about what's typical"; outside it names the
 * signed difference. Today is never judged — it is incomplete.
 */
export const composeYesterdayLine = (params: {
  kwhTotal: number;
  tempMeanC: number;
  deviationKwh: number | null;
  typicalLowDeviation: number;
  typicalHighDeviation: number;
}): string => {
  const { kwhTotal, tempMeanC, deviationKwh, typicalLowDeviation, typicalHighDeviation } = params;
  const prefix = `Yesterday: ${formatDailyKwh(kwhTotal)} — `;
  const temp = formatTempC(tempMeanC);
  if (deviationKwh === null || (deviationKwh >= typicalLowDeviation && deviationKwh <= typicalHighDeviation)) {
    return `${prefix}about what’s typical for ${temp}.`;
  }
  const magnitude = formatDailyKwh(Math.abs(deviationKwh));
  return deviationKwh > 0
    ? `${prefix}${magnitude} more than typical for ${temp}.`
    : `${prefix}${magnitude} less than typical for ${temp}.`;
};

/** S6 drift subline (warn tone) — cause candidates plus a self-healing promise. */
export const composeDriftNotice = (deviationKwhPerDay: number): string => (
  `Recent days run about ${formatDailyKwh(Math.max(0, deviationKwhPerDay))}/day above what’s typical for the `
  + 'temperature. If something changed — a new device, guests, heating settings — the estimate will '
  + 'catch up over a few weeks.'
);

// ── Detail view: "Your home in numbers" ────────────────────────────────────

export const WEATHER_NUMBERS_TITLE = 'Your home in numbers';
export const WEATHER_ROW_WARM_DAY_USAGE = 'Warm-day usage';
export const WEATHER_ROW_PER_DEGREE = 'Each degree colder';
export const WEATHER_ROW_HEATING_BELOW = 'Heating kicks in below';
export const WEATHER_VALUE_NOT_CLEAR_YET = 'Not clear yet';
export const WEATHER_MORE_DETAIL = 'More detail';

export const formatWarmDayUsage = (baseLoadKwhPerDay: number): string => (
  `≈ ${formatDailyKwh(baseLoadKwhPerDay)}/day`
);

export const composeNumbersFootnote = (
  usableDays: number,
  backfilledDays: number,
  suppressedDaysExcluded = 0,
): string => {
  const base = backfilledDays > 0
    ? `Based on ${formatDays(usableDays)}, backfilled from your usage history.`
    : `Based on ${formatDays(usableDays)}.`;
  return suppressedDaysExcluded > 0
    ? `${base} ${formatDays(suppressedDaysExcluded)} left out — your budget limited them.`
    : base;
};

export const composeSlopeRange = (lowKwhPerDegree: number, highKwhPerDegree: number): string => (
  `Usually between +${lowKwhPerDegree.toFixed(1)} and +${highKwhPerDegree.toFixed(1)} kWh per degree.`
);

export const WEATHER_CURVATURE_NOTE = 'Usage rises faster on the coldest days — common for heat pumps.';

export const composeHeatLossDetail = (wPerK: number): string => (
  `Rough heat loss: ${formatHeatLossW(wPerK)} of indoor–outdoor difference. Treat as a ballpark — it `
  + 'assumes electric heating covers all heat loss; with a heat pump the true figure is higher.'
);

/** S4 supporting line: the cold half is trustworthy, the warm half is a promise. */
export const composeWinterOnlySupport = (warmestObservedC: number): string => (
  `PELS has only seen days below ${formatTempC(warmestObservedC)} so far. Cold-weather estimates are `
  + 'solid; warm-weather numbers will fill in as the season turns.'
);

// ── Detail view: scatter + coverage ────────────────────────────────────────

export const WEATHER_SCATTER_TITLE = 'Usage and outside temperature';
export const WEATHER_SCATTER_SUBTITLE = 'Each dot is one day from the last year.';
export const WEATHER_SCATTER_SUBTITLE_LEARNING = 'Each dot is one day. Estimates appear after about 21 days.';
export const WEATHER_LEGEND_DAY = 'One day';
export const WEATHER_LEGEND_ESTIMATE = 'Estimate';
export const WEATHER_LEGEND_TOMORROW = 'Tomorrow';

/** Axis-side micro-label for the balance tick (`≈13°`). */
export const composeBalanceTickLabel = (balancePointC: number): string => (
  `≈${signed(Math.round(balancePointC), String(Math.abs(Math.round(balancePointC))))}°`
);

export const composeBalanceTooltip = (balancePointC: number): string => (
  `Below about ${formatTempC(balancePointC)}, heating pushes usage up.`
);

export const composeTomorrowDotTooltip = (params: {
  tempMeanC: number;
  lowKwh: number;
  highKwh: number;
}): string => (
  `Tomorrow ≈ ${formatTempC(params.tempMeanC)} — expect ${formatKwhRange(params.lowKwh, params.highKwh)}.`
);

export const composeDayDotTooltip = (params: {
  dateKey: string;
  tempMeanC: number;
  kwhTotal: number;
  partial: boolean;
}): string => {
  const base = `${formatTooltipDate(params.dateKey)} · ${formatTempC(params.tempMeanC)} · `
    + `${formatDailyKwh(params.kwhTotal)}`;
  return params.partial ? `${base} · partial day` : base;
};

export const composeBinTooltip = (params: {
  tempBinC: number;
  kwhQ1: number;
  kwhQ3: number;
  count: number;
}): string => (
  `Around ${formatTempC(params.tempBinC)}: typically ${formatKwhRange(params.kwhQ1, params.kwhQ3)} `
  + `(${formatDays(params.count)})`
);

export const WEATHER_COVERAGE_LEGEND = 'Darker = more days measured.';

/**
 * Coverage caption from the 5 °C bins: the solid span plus at most one edge
 * sentence for the rougher side. Empty when no bin is solid yet — the band's
 * shades already tell that story.
 */
export const composeCoverageCaption = (bins: WeatherCoverageBin[]): string => {
  const solid = bins.filter((bin) => bin.sufficient);
  if (solid.length === 0) return '';
  const solidFromC = Math.min(...solid.map((bin) => bin.fromC));
  const solidToC = Math.max(...solid.map((bin) => bin.toC));
  const sentences = [`Solid from ${formatTempC(solidFromC)} to ${formatTempC(solidToC)}.`];
  const hasSparseCold = bins.some((bin) => !bin.sufficient && bin.toC <= solidFromC);
  const hasSparseWarm = bins.some((bin) => !bin.sufficient && bin.fromC >= solidToC);
  if (hasSparseCold) {
    sentences.push(`Few days colder than ${formatTempC(solidFromC)} — estimates there are rougher.`);
  } else if (hasSparseWarm) {
    sentences.push(`Few days warmer than ${formatTempC(solidToC)} — estimates there are rougher.`);
  }
  return sentences.join(' ');
};

// ── Detail view: device footer ─────────────────────────────────────────────

export const composeDeviceFooter = (params: {
  outdoorDeviceName: string | null;
  outdoorDeviceConfigured: boolean;
  forecastDeviceName: string | null;
  /** Producer-resolved forecast provenance — the footer maps it straight to copy. */
  forecastStatus: WeatherForecastStatus;
}): string => (
  `${composeFooterOutdoor(params)} · ${composeFooterForecast(params)}`
);

const composeFooterOutdoor = (params: {
  outdoorDeviceName: string | null;
  outdoorDeviceConfigured: boolean;
}): string => {
  if (params.outdoorDeviceName !== null) return `Temperature: ${params.outdoorDeviceName}`;
  // A configured device whose name couldn't be read is "not responding", never
  // "not set" — the user must be able to tell a lost setting from a quiet device.
  return params.outdoorDeviceConfigured ? 'Temperature: not responding' : 'Temperature: not set';
};

const composeFooterForecast = (params: {
  forecastDeviceName: string | null;
  forecastStatus: WeatherForecastStatus;
}): string => {
  if (params.forecastStatus === 'recent_no_device') return 'Forecast: none — using recent days';
  const name = params.forecastDeviceName ?? 'device';
  return params.forecastStatus === 'forecast'
    ? `Forecast: ${name}`
    : `Forecast: ${name} isn’t reporting — using recent days`;
};

export const WEATHER_BUTTON_CHANGE_IN_SETTINGS = 'Change in Settings';

// ── States S1–S3 + error ───────────────────────────────────────────────────

export const WEATHER_SETUP_TITLE = WEATHER_INSIGHT_TITLE;
export const WEATHER_SETUP_BODY = 'PELS can learn how outside temperature drives your daily usage, '
  + 'and predict tomorrow’s total. Pick the device that measures outdoor temperature to start.';
export const WEATHER_SETUP_BUTTON = 'Choose temperature device';
/**
 * Gentle nudge on the setup card, shown only when no daily budget is configured.
 * Names what the budget unlocks (the tomorrow verdict) rather than vaguely
 * grading the whole feature — prediction/numbers work without a budget.
 */
export const WEATHER_SETUP_BUDGET_HINT = 'Set a daily budget and PELS can tell you whether '
  + 'tomorrow fits inside it.';

export const WEATHER_BACKFILL_TITLE = 'Reading your history…';
export const WEATHER_BACKFILL_BODY = 'Matching the past year of your usage with past temperatures. '
  + 'This runs once and can take a few minutes the first time.';

export const WEATHER_LEARNING_TITLE = 'Learning your home';
/**
 * Warn note on the learning card when the configured outdoor device reads
 * unreadable. Conditional ("right now" / "if this keeps up") because the signal
 * is a single live read that may be a transient miss — it must not assert the
 * feature is broken on one failed read.
 */
// Names the actual control to fix (mirrors WEATHER_OUTDOOR_PICKER_LABEL — that
// const is declared later in this file, so the label is inlined here).
export const WEATHER_LEARNING_STUCK = 'PELS can’t read your outdoor device right now — if this '
  + 'keeps up, learning will stall. Check the Outdoor temperature device in Settings.';
/** One-time celebration when the first estimate becomes available. */
export const WEATHER_FIRST_ESTIMATE_TOAST = 'Weather insight is ready — here’s tomorrow’s outlook.';
export const composeLearningBody = (usableDays: number): string => (
  `PELS has ${formatDays(usableDays)} of usage and temperature so far. The first estimate appears `
  + 'after about 21 days.'
);

export const WEATHER_ERROR_TITLE = 'Weather insight isn’t available right now.';
export const WEATHER_ERROR_BODY = 'Couldn’t load the weather readout. PELS will try again the next '
  + 'time you open this page.';

// ── Settings section ───────────────────────────────────────────────────────
// The sub-page title comes from the panel hero (static); this section renders
// the master on/off switch, then (when on) the intro hint + the two pickers.

/**
 * Master switch row at the top of the sub-page. The page hero already names the
 * feature, so the supporting line carries the value proposition — what turning
 * it on actually does. Shown whether the feature is on or off (the switch is the
 * feature gate; off ⇒ only this row renders).
 */
export const WEATHER_ENABLE_LABEL = 'Weather insight';
export const WEATHER_ENABLE_SUPPORTING = 'Predict tomorrow’s usage from outside temperature.';
/**
 * Off-state pitch shown below the master switch — leads with the budget payoff
 * (the reason to turn it on) and names the next step, so the off page sells the
 * feature instead of reading as a bare toggle. Readable body copy, not a muted
 * hint. No daily budget configured is fine — the setup card nudges that later.
 */
export const WEATHER_DISABLED_PITCH = 'See whether tomorrow’s weather will fit inside your daily '
  + 'budget. Turn it on and pick your outdoor temperature device to start.';

export const WEATHER_SETTINGS_SECTION_HINT = 'Pick the devices PELS should read.';

// ── Auto-apply suggested budget ────────────────────────────────────────────
// A switch on the sub-page (below the pickers) that lets the suggested daily
// budget set the daily budget automatically each day. Off by default.

export const WEATHER_AUTO_APPLY_LABEL = 'Apply the suggestion automatically';
// Names the COST, not just the action: it replaces a number the user set by hand.
export const WEATHER_AUTO_APPLY_SUPPORTING = 'Each day, PELS replaces your daily budget with the '
  + 'suggested value.';
/** Inert-state hint: names the control AND where to reach it, so it isn't a dead end. */
export const WEATHER_AUTO_APPLY_NEEDS_BUDGET = 'Enable the daily budget in Budget settings for this '
  + 'to take effect.';
/** Tomorrow-card status line, shown when auto-apply is on, explaining why the budget tracks the suggestion. */
export const WEATHER_AUTO_APPLY_STATUS = 'PELS sets your daily budget automatically each day.';

/** "Last applied: 44 kWh on 13 Jun." under the auto-apply switch. */
export const composeLastAutoApply = (dateKey: string, kwh: number): string => (
  `Last applied: ${formatDailyKwh(kwh)} on ${formatTooltipDate(dateKey)}.`
);

/** Shown when no Homey device exposes a temperature reading PELS can use. */
export const WEATHER_NO_TEMPERATURE_DEVICES = 'PELS found no temperature devices in Homey. Add a '
  + 'device that reports outdoor temperature on its main reading, then pick it here.';
export const WEATHER_OUTDOOR_PICKER_LABEL = 'Outdoor temperature device';
export const WEATHER_OUTDOOR_PICKER_HINT = 'Pick a device that reports the current outdoor '
  + 'temperature at your home.';
export const WEATHER_FORECAST_PICKER_LABEL = 'Forecast device';
export const WEATHER_FORECAST_PICKER_HINT = 'Optional. Point this at a device that reports '
  + 'tomorrow’s outdoor temperature on its main temperature reading — a Yr “next 24 hours” device '
  + 'works. If PELS can’t read a forecast, it uses your recent days instead.';
export const WEATHER_PICKER_NONE = 'No device';
/** A previously-selected device that is no longer in Homey (kept selectable so the setting isn't lost). */
export const WEATHER_PICKER_ORPHAN = 'Previously selected device (no longer available)';
/** A configured device shown before the device list has loaded (neutral, not "deleted"). */
export const WEATHER_PICKER_SELECTED_LOADING = 'Selected device';

// ── Picker live-validity lines ─────────────────────────────────────────────
// Shown under each picker so the user sees a chosen device actually works the
// instant they pick it, instead of waiting ~21 days for the first estimate.

export type WeatherReadingLine = { text: string; tone: 'ok' | 'warn' };

/** Live outdoor reading under the outdoor picker; null when no device is configured. */
export const composeOutdoorReadingLine = (reading: WeatherDeviceReading): WeatherReadingLine | null => {
  if (reading.status === 'no_device') return null;
  if (reading.status === 'reading') return { text: `Reading ${formatTempC(reading.tempC)} now`, tone: 'ok' };
  // The remedy points at the actual failure mode (a non-temperature device, or
  // one reporting on a sub-capability) — and the warn line is self-contained
  // because the static hint is hidden once a device is selected.
  return {
    text: 'PELS can’t read a temperature from this device — pick one that reports temperature on its main reading.',
    tone: 'warn',
  };
};

/** Live forecast reading under the forecast picker; null when no device is configured. */
export const composeForecastReadingLine = (reading: WeatherDeviceReading): WeatherReadingLine | null => {
  if (reading.status === 'no_device') return null;
  if (reading.status === 'reading') {
    return { text: `Reading tomorrow ${formatApproxTempC(reading.tempC)}`, tone: 'ok' };
  }
  // The on-demand read means a warn = the device's main temperature reading isn't
  // readable (sub-capability-only, wrong device, or transient); name that fix and
  // the recent-days fallback. Mirrors the outdoor warn's "main reading" remedy.
  return {
    text: 'This device isn’t reporting tomorrow’s temperature on its main reading — using recent days for now.',
    tone: 'warn',
  };
};
