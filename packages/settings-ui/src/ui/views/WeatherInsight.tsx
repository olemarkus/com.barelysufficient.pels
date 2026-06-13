import type { ComponentChildren } from 'preact';
import { MdElevation, MdTextButton } from './materialWebJSX.tsx';
import { ExpandMoreIcon } from './icons.tsx';
import type {
  EnergySignatureFit,
  WeatherAdvisorReadoutPayload,
} from '../../../../contracts/src/weatherAdvisorTypes.ts';
import {
  composeBasedOnDays,
  composeDeviceFooter,
  composeDriftNotice,
  composeHeatLossDetail,
  composeLearningBody,
  composeNumbersFootnote,
  composeSlopeRange,
  composeSummaryHeadline,
  composeTomorrowTitle,
  composeUncorrelatedSummary,
  composeWinterOnlyHeadline,
  composeWinterOnlySupport,
  composeYesterdayLine,
  formatApproxTempC,
  formatDailyKwh,
  formatKwhRange,
  formatPerDegree,
  formatWarmDayUsage,
  resolveTomorrowVerdict,
  resolveWeatherConfidenceChip,
  WEATHER_BACKFILL_BODY,
  WEATHER_BACKFILL_TITLE,
  WEATHER_BUTTON_ADJUST_BUDGET,
  WEATHER_BUTTON_CHANGE_IN_SETTINGS,
  WEATHER_BUTTON_DETAILS,
  WEATHER_CHIP_ROUGH_ESTIMATE,
  WEATHER_CURVATURE_NOTE,
  WEATHER_ERROR_BODY,
  WEATHER_ERROR_TITLE,
  WEATHER_EXPECTED_FROM_RECENT_DAYS,
  WEATHER_INSIGHT_TITLE,
  WEATHER_LEARNING_TITLE,
  WEATHER_LEGEND_DAY,
  WEATHER_LEGEND_ESTIMATE,
  WEATHER_LEGEND_TOMORROW,
  WEATHER_MORE_DETAIL,
  WEATHER_NUMBERS_TITLE,
  WEATHER_REASON_BUDGET_LIMITING,
  WEATHER_REASON_COLDER_THAN_OBSERVED,
  WEATHER_REASON_DRIFT_WIDER,
  WEATHER_ROW_EXPECTED_USAGE,
  WEATHER_ROW_HEATING_BELOW,
  WEATHER_ROW_PER_DEGREE,
  WEATHER_ROW_SUGGESTED_BUDGET,
  WEATHER_ROW_WARM_DAY_USAGE,
  WEATHER_ROW_YOUR_BUDGET,
  WEATHER_SCATTER_SUBTITLE,
  WEATHER_SCATTER_SUBTITLE_LEARNING,
  WEATHER_SCATTER_TITLE,
  WEATHER_SETUP_BODY,
  WEATHER_SETUP_BUTTON,
  WEATHER_SOURCE_FORECAST,
  WEATHER_SOURCE_PERSISTENCE,
  WEATHER_VALUE_NOT_CLEAR_YET,
} from '../../../../shared-domain/src/weatherInsightCopy.ts';
import { WeatherCoverageBand, WeatherScatterChart } from './WeatherInsightChart.tsx';

// Budget-page Tomorrow card + the Weather insight detail view. Spec of
// record: notes/weather-insight-spec.md (S1–S8 copy, marker grammar). All
// strings come from shared-domain weatherInsightCopy helpers — never inline.

/**
 * Controller-supplied view data. `null` (flag off) keeps every weather DOM id
 * out of the tree — structural absence, not hiding. A null readout with
 * `fetchFailed` renders the quiet error card; null readout while a fetch is
 * still in flight renders nothing (the card pops in when data lands).
 */
export type WeatherInsightCardData = {
  readout: WeatherAdvisorReadoutPayload | null;
  fetchFailed: boolean;
};

type CardCallbacks = {
  onShowDetails: () => void;
  onAdjustBudget: () => void;
};

const StateCard = ({ id, title, body, children }: {
  id: string;
  title: string;
  body: string;
  children?: ComponentChildren;
}) => (
  <section id={id} class="pels-surface-card budget-redesign-card weather-card">
    <MdElevation aria-hidden="true" />
    <h3 class="plan-card__title">{title}</h3>
    <p class="pels-card-supporting">{body}</p>
    {children}
  </section>
);

const TomorrowCard = ({ readout, onShowDetails, onAdjustBudget }: {
  readout: WeatherAdvisorReadoutPayload;
} & CardCallbacks) => {
  const { prediction, suggestion, fit } = readout;
  const roughReason = prediction?.beyondObservedCold
    ? WEATHER_REASON_COLDER_THAN_OBSERVED
    : (readout.driftSuspected ? WEATHER_REASON_DRIFT_WIDER : null);
  const verdict = prediction && fit
    ? resolveTomorrowVerdict({
      currentDailyBudgetKwh: suggestion?.currentDailyBudgetKwh ?? null,
      predictionKwh: prediction.kwh,
      residualQ50: fit.residualQ50,
      residualQ80: fit.residualQ80,
      residualQ90: fit.residualQ90,
    })
    : null;
  return (
    <section id="weather-tomorrow-card" class="pels-surface-card budget-redesign-card weather-card">
      <MdElevation aria-hidden="true" />
      <div class="weather-card__title-row">
        <h3 class="plan-card__title">
          {prediction ? composeTomorrowTitle(prediction.tempMeanC) : WEATHER_INSIGHT_TITLE}
        </h3>
        {roughReason !== null && (
          <span class="plan-chip plan-chip--warn">{WEATHER_CHIP_ROUGH_ESTIMATE}</span>
        )}
      </div>
      {prediction && (
        <p class="pels-card-supporting">
          {prediction.source === 'forecast' ? WEATHER_SOURCE_FORECAST : WEATHER_SOURCE_PERSISTENCE}
        </p>
      )}
      {roughReason !== null && (
        <p class="pels-card-supporting weather-card__reason">{roughReason}</p>
      )}
      {prediction && (
        <div class="budget-settings-list budget-settings-list--compact">
          <div class="budget-setting-row">
            <span class="budget-setting-row__label">{WEATHER_ROW_EXPECTED_USAGE}</span>
            <span class="budget-setting-row__value">
              {formatKwhRange(prediction.lowKwh, prediction.highKwh)}
            </span>
          </div>
          {fit?.model === 'uncorrelated' && (
            <p class="pels-card-supporting weather-card__row-note">{WEATHER_EXPECTED_FROM_RECENT_DAYS}</p>
          )}
          {suggestion && (
            <div class="budget-setting-row">
              <span class="budget-setting-row__label">{WEATHER_ROW_SUGGESTED_BUDGET}</span>
              <span class="budget-setting-row__value">{formatDailyKwh(suggestion.kwh)}</span>
            </div>
          )}
          {suggestion?.currentDailyBudgetKwh != null && (
            <div class="budget-setting-row">
              <span class="budget-setting-row__label">{WEATHER_ROW_YOUR_BUDGET}</span>
              <span class="budget-setting-row__value">
                {formatDailyKwh(suggestion.currentDailyBudgetKwh)}
              </span>
            </div>
          )}
        </div>
      )}
      {verdict !== null && (
        <p class={`weather-card__verdict weather-card__verdict--${verdict.tone}`}>{verdict.text}</p>
      )}
      {suggestion?.budgetMayBeLimiting === true && (
        <p class="pels-card-supporting weather-card__reason">{WEATHER_REASON_BUDGET_LIMITING}</p>
      )}
      <div class="weather-card__actions">
        {/* Opens the normal Adjust flow, UNPREFILLED — the suggestion is display-only. */}
        <MdTextButton id="weather-adjust-budget" onClick={onAdjustBudget}>
          {WEATHER_BUTTON_ADJUST_BUDGET}
        </MdTextButton>
        <MdTextButton id="weather-details-button" onClick={onShowDetails}>
          {WEATHER_BUTTON_DETAILS}
        </MdTextButton>
      </div>
    </section>
  );
};

/**
 * The Budget plan-view slot: one card, switching on readout state. Returns
 * null (no DOM at all) when the feature is off or data hasn't arrived yet.
 */
export const WeatherBudgetCard = ({ data, onShowDetails, onAdjustBudget }: {
  data: WeatherInsightCardData | null;
} & CardCallbacks) => {
  if (data === null) return null;
  if (data.readout === null) {
    if (!data.fetchFailed) return null;
    return <StateCard id="weather-error-card" title={WEATHER_ERROR_TITLE} body={WEATHER_ERROR_BODY} />;
  }
  const readout = data.readout;
  if (readout.state === 'needs_device') {
    return (
      <StateCard id="weather-setup-card" title={WEATHER_INSIGHT_TITLE} body={WEATHER_SETUP_BODY}>
        <div class="weather-card__actions">
          <MdTextButton id="weather-setup-pick-device" data-settings-target="settings">
            {WEATHER_SETUP_BUTTON}
          </MdTextButton>
        </div>
      </StateCard>
    );
  }
  if (readout.state === 'backfilling') {
    return <StateCard id="weather-backfill-card" title={WEATHER_BACKFILL_TITLE} body={WEATHER_BACKFILL_BODY} />;
  }
  if (readout.state === 'learning') {
    return (
      <StateCard
        id="weather-learning-card"
        title={WEATHER_LEARNING_TITLE}
        body={composeLearningBody(readout.usableDays)}
      >
        <div class="weather-card__actions">
          <MdTextButton id="weather-details-button" onClick={onShowDetails}>
            {WEATHER_BUTTON_DETAILS}
          </MdTextButton>
        </div>
      </StateCard>
    );
  }
  if (readout.state === 'error') {
    return <StateCard id="weather-error-card" title={WEATHER_ERROR_TITLE} body={WEATHER_ERROR_BODY} />;
  }
  return <TomorrowCard readout={readout} onShowDetails={onShowDetails} onAdjustBudget={onAdjustBudget} />;
};

// ─── Detail view ──────────────────────────────────────────────────────────────

const summaryHeadline = (fit: EnergySignatureFit): string => {
  if (fit.model === 'uncorrelated') return composeUncorrelatedSummary(fit.usableDays);
  if (fit.model === 'linear') {
    return composeWinterOnlyHeadline({
      kwhAtZeroC: fit.interceptKwhAtZeroC ?? 0,
      slopeKwhPerDegree: fit.slopeKwhPerDegree,
    });
  }
  return composeSummaryHeadline({
    baseLoadKwhPerDay: fit.baseLoadKwhPerDay ?? 0,
    slopeKwhPerDegree: fit.slopeKwhPerDegree,
    balancePointC: fit.balancePointC ?? 0,
  });
};

const SummaryCard = ({ readout, fit }: { readout: WeatherAdvisorReadoutPayload; fit: EnergySignatureFit }) => {
  const chip = resolveWeatherConfidenceChip(fit.confidence);
  return (
    <section id="weather-summary-card" class="pels-surface-card budget-redesign-card weather-card">
      <MdElevation aria-hidden="true" />
      {chip !== null && (
        <div class="weather-card__chips">
          <span class="plan-chip plan-chip--info">{chip}</span>
        </div>
      )}
      <p class="plan-hero__decision weather-summary__headline">{summaryHeadline(fit)}</p>
      <p class="pels-card-supporting">{composeBasedOnDays(fit.usableDays)}</p>
      {readout.yesterday !== null && (
        <p class="pels-card-supporting">
          {composeYesterdayLine({
            kwhTotal: readout.yesterday.kwhTotal,
            tempMeanC: readout.yesterday.tempMeanC,
            deviationKwh: readout.yesterday.deviationKwh,
            typicalLowDeviation: fit.residualQ10,
            typicalHighDeviation: fit.residualQ90,
          })}
        </p>
      )}
      {readout.driftSuspected && (
        <p class="pels-card-supporting weather-card__reason">
          {composeDriftNotice(readout.driftDeviationKwh ?? 0)}
        </p>
      )}
    </section>
  );
};

const NumbersCard = ({ readout, fit }: { readout: WeatherAdvisorReadoutPayload; fit: EnergySignatureFit }) => {
  const isChangepoint = fit.model === 'changepoint';
  const rows = [
    {
      label: WEATHER_ROW_WARM_DAY_USAGE,
      value: isChangepoint ? formatWarmDayUsage(fit.baseLoadKwhPerDay ?? 0) : WEATHER_VALUE_NOT_CLEAR_YET,
    },
    { label: WEATHER_ROW_PER_DEGREE, value: formatPerDegree(fit.slopeKwhPerDegree) },
    {
      label: WEATHER_ROW_HEATING_BELOW,
      value: isChangepoint ? formatApproxTempC(fit.balancePointC ?? 0) : WEATHER_VALUE_NOT_CLEAR_YET,
    },
  ];
  return (
    <section id="weather-numbers-card" class="pels-surface-card budget-redesign-card weather-card">
      <MdElevation aria-hidden="true" />
      <h3 class="plan-card__title">{WEATHER_NUMBERS_TITLE}</h3>
      <div class="budget-settings-list budget-settings-list--compact">
        {rows.map((row) => (
          <div key={row.label} class="budget-setting-row">
            <span class="budget-setting-row__label">{row.label}</span>
            <span class="budget-setting-row__value">{row.value}</span>
          </div>
        ))}
      </div>
      <p class="pels-card-supporting">
        {composeNumbersFootnote(fit.usableDays, readout.backfilledDays, readout.suppressedDaysExcluded)}
      </p>
      {fit.model === 'linear' && (
        <p class="pels-card-supporting">{composeWinterOnlySupport(fit.observedTempMaxC)}</p>
      )}
      <details class="weather-numbers__details">
        <summary class="weather-numbers__summary">
          <span class="pels-card-supporting">{WEATHER_MORE_DETAIL}</span>
          <ExpandMoreIcon class="disclosure-chevron" />
        </summary>
        {fit.slopeCiLow !== undefined && fit.slopeCiHigh !== undefined && (
          <p class="pels-card-supporting">{composeSlopeRange(fit.slopeCiLow, fit.slopeCiHigh)}</p>
        )}
        {fit.curvatureSteeperWhenCold && (
          <p class="pels-card-supporting">{WEATHER_CURVATURE_NOTE}</p>
        )}
        {fit.heatLossWPerK !== undefined && (
          <p class="pels-card-supporting">{composeHeatLossDetail(fit.heatLossWPerK)}</p>
        )}
      </details>
    </section>
  );
};

const ScatterCard = ({ readout }: { readout: WeatherAdvisorReadoutPayload }) => {
  const learning = readout.state === 'learning';
  const uncorrelated = readout.fit?.model === 'uncorrelated';
  return (
    <section id="weather-scatter-card" class="pels-surface-card budget-redesign-card weather-card">
      <MdElevation aria-hidden="true" />
      <h3 class="plan-card__title">{WEATHER_SCATTER_TITLE}</h3>
      <p class="pels-card-supporting">
        {learning ? WEATHER_SCATTER_SUBTITLE_LEARNING : WEATHER_SCATTER_SUBTITLE}
      </p>
      <div class="budget-chart-legend">
        <span class="budget-chart-legend__item">
          <span class="budget-chart-legend__swatch weather-legend__swatch--day" />
          <span>{WEATHER_LEGEND_DAY}</span>
        </span>
        {!uncorrelated && !learning && (
          <span class="budget-chart-legend__item">
            <span class="budget-chart-legend__swatch weather-legend__swatch--estimate" />
            <span>{WEATHER_LEGEND_ESTIMATE}</span>
          </span>
        )}
        {readout.prediction !== null && (
          <span class="budget-chart-legend__item">
            <span class="budget-chart-legend__swatch weather-legend__swatch--tomorrow" />
            <span>{WEATHER_LEGEND_TOMORROW}</span>
          </span>
        )}
      </div>
      <WeatherScatterChart
        scatter={readout.scatter}
        recentDays={readout.recentDays}
        fit={readout.fit}
        prediction={readout.prediction}
        yesterdayDateKey={readout.yesterday?.dateKey ?? null}
      />
      {!learning && !uncorrelated && (
        <WeatherCoverageBand
          coverage={readout.coverage}
          tomorrowTempC={readout.prediction?.tempMeanC ?? null}
        />
      )}
    </section>
  );
};

const DeviceFooter = ({ readout }: { readout: WeatherAdvisorReadoutPayload }) => (
  <section id="weather-device-footer" class="pels-surface-card budget-redesign-card weather-card weather-device-footer">
    <MdElevation aria-hidden="true" />
    <p class="pels-card-supporting">
      {composeDeviceFooter({
        outdoorDeviceName: readout.settings.outdoorDeviceName,
        forecastDeviceName: readout.settings.forecastDeviceName,
      })}
    </p>
    <MdTextButton id="weather-change-in-settings" data-settings-target="settings">
      {WEATHER_BUTTON_CHANGE_IN_SETTINGS}
    </MdTextButton>
  </section>
);

/** Detail surface (`localView === 'weather'`): summary → numbers → scatter → devices. */
export const WeatherInsightDetail = ({ readout }: { readout: WeatherAdvisorReadoutPayload }) => {
  const fit = readout.fit;
  const showNumbers = fit !== null && fit.model !== 'uncorrelated' && readout.state === 'ready';
  return (
    <div id="weather-insight-view" class="budget-redesign-view">
      {fit !== null && readout.state === 'ready' && <SummaryCard readout={readout} fit={fit} />}
      {showNumbers && <NumbersCard readout={readout} fit={fit} />}
      <ScatterCard readout={readout} />
      <DeviceFooter readout={readout} />
    </div>
  );
};
