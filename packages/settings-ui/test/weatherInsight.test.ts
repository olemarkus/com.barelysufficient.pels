import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';
import { renderWeatherSettingsSection } from '../src/ui/views/WeatherSettingsSection.tsx';
import type {
  EnergySignatureFit,
  WeatherAdvisorReadoutPayload,
} from '../../contracts/src/weatherAdvisorTypes';
import {
  composeBasedOnDays,
  composeLearningBody,
  composeSummaryHeadline,
  composeTomorrowTitle,
  composeUncorrelatedSummary,
  composeYesterdayLine,
  formatDailyKwh,
  formatKwhRange,
  resolveTomorrowVerdict,
  WEATHER_BACKFILL_BODY,
  WEATHER_BACKFILL_TITLE,
  WEATHER_CHIP_ROUGH_ESTIMATE,
  WEATHER_ERROR_TITLE,
  WEATHER_FORECAST_PICKER_LABEL,
  WEATHER_INSIGHT_TITLE,
  WEATHER_OUTDOOR_PICKER_LABEL,
  WEATHER_REASON_COLDER_THAN_OBSERVED,
  WEATHER_SCATTER_SUBTITLE_LEARNING,
  WEATHER_SETUP_BODY,
  WEATHER_SETUP_BUTTON,
  WEATHER_SOURCE_FORECAST,
} from '../../shared-domain/src/weatherInsightCopy';

/* -------------------------------------------------------------------------- *
 * Weather insight render tests: every state branch of the Budget-page card
 * slot (S1 setup / S2 backfill / S3 learning / ready / error), structural
 * absence when the flag is off (prop null), the detail view, and the Settings
 * pickers section. All copy assertions pin the rendered text to the
 * shared-domain weatherInsightCopy helpers byte-for-byte, so a runtime log
 * quoting the same helper stays in lockstep with the UI.
 * -------------------------------------------------------------------------- */

const buildFit = (overrides: Partial<EnergySignatureFit> = {}): EnergySignatureFit => ({
  model: 'changepoint',
  baseLoadKwhPerDay: 23,
  slopeKwhPerDegree: 1.8,
  slopeCiLow: 1.5,
  slopeCiHigh: 2.1,
  balancePointC: 13,
  pseudoR2: 0.7,
  usableDays: 287,
  observedTempMinC: -12,
  observedTempMaxC: 24,
  medianDayKwh: 38,
  lowObservedDayKwh: 20,
  confidence: 'high',
  curvatureSteeperWhenCold: false,
  heatLossWPerK: 75,
  driftSuspected: false,
  suppressedDaysExcluded: 0,
  suppressionFilterRelaxed: false,
  recentColdSuppressionSuspected: false,
  residualQ10: -5,
  residualQ50: 0,
  residualQ80: 5,
  residualQ90: 7,
  fittedAtMs: 1_700_000_000_000,
  ...overrides,
});

const buildReadout = (
  overrides: Partial<WeatherAdvisorReadoutPayload> = {},
): WeatherAdvisorReadoutPayload => ({
  state: 'ready',
  driftSuspected: false,
  driftDeviationKwh: null,
  settings: {
    outdoorDeviceId: 'dev-outdoor',
    outdoorDeviceName: 'Outdoor sensor',
    forecastDeviceId: 'dev-forecast',
    forecastDeviceName: 'Yr forecast',
  },
  fit: buildFit(),
  coverage: [
    { fromC: -10, toC: -5, days: 6, sufficient: false },
    { fromC: -5, toC: 0, days: 22, sufficient: true },
    { fromC: 0, toC: 5, days: 40, sufficient: true },
  ],
  prediction: {
    tempMeanC: 2,
    source: 'forecast',
    kwh: 42.8,
    lowKwh: 38,
    highKwh: 50,
    beyondObservedCold: false,
    beyondObservedWarm: false,
  },
  suggestion: { kwh: 48, currentDailyBudgetKwh: 50, cappedByCapacity: false, budgetMayBeLimiting: false },
  scatter: [{ tempBinC: 2, kwhMedian: 42, kwhQ1: 39, kwhQ3: 45, count: 12 }],
  recentDays: [{
    dateKey: '2026-06-10',
    tempMeanC: 3,
    kwhTotal: 47,
    quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  }],
  yesterday: { dateKey: '2026-06-10', tempMeanC: 3, kwhTotal: 47, deviationKwh: 1.2 },
  usableDays: 287,
  backfilledDays: 240,
  suppressedDaysExcluded: 0,
  generatedAtMs: 1_700_000_000_000,
  ...overrides,
});

const buildProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => ({
  localView: 'plan',
  view: 'today',
  hero: {
    headlineLabel: null,
    comparison: 'On budget',
    delta: null,
    budgetRemainingLine: null,
    splitLine: null,
    priceTagline: null,
    decision: null,
    heroTone: 'ok',
  },
  chart: null,
  confidence: null,
  adjust: {
    draft: { enabled: true, dailyBudgetKWh: 50, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    active: { enabled: true, dailyBudgetKWh: 50, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    candidate: null,
    activeChart: null,
    candidateChart: null,
    comparisonDayView: 'today',
    comparisonDayLabel: 'Today',
    comparisonShowPrice: false,
    status: 'clean',
    busy: false,
    hardCapKw: 12,
    safetyMarginKw: 1,
  },
  allocationWarning: null,
  priceLevelChip: null,
  weatherInsight: { readout: buildReadout(), fetchFailed: false },
  adjustReturnTarget: 'plan',
  onReturnToSettings: () => {},
  onLocalViewChange: () => {},
  onDayChange: () => {},
  onChartModeChange: () => {},
  onAdjustFieldChange: () => {},
  onPreview: () => {},
  onApply: () => {},
  onDiscard: () => {},
  ...overrides,
});

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('WeatherBudgetCard (Budget plan slot)', () => {
  it('renders no weather DOM at all when the flag is off (prop null)', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildProps({ weatherInsight: null }));
    expect(mount.querySelectorAll('[id^="weather-"]')).toHaveLength(0);
  });

  it('renders nothing while the readout is still loading (null, no failure)', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout: null, fetchFailed: false } }));
    expect(mount.querySelectorAll('[id^="weather-"]')).toHaveLength(0);
  });

  it('renders the quiet error card when the readout fetch failed', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout: null, fetchFailed: true } }));
    const card = mount.querySelector('#weather-error-card');
    expect(card?.textContent).toContain(WEATHER_ERROR_TITLE);
  });

  it('S1: renders the setup card with the settings deep-link', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({ state: 'needs_device', fit: null, prediction: null, suggestion: null });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-setup-card');
    expect(card?.textContent).toContain(WEATHER_INSIGHT_TITLE);
    expect(card?.textContent).toContain(WEATHER_SETUP_BODY);
    const button = card?.querySelector('#weather-setup-pick-device');
    expect(button?.textContent).toContain(WEATHER_SETUP_BUTTON);
    expect(button?.getAttribute('data-settings-target')).toBe('settings');
  });

  it('S2: renders the backfilling card', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({ state: 'backfilling', fit: null, prediction: null, suggestion: null });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-backfill-card');
    expect(card?.textContent).toContain(WEATHER_BACKFILL_TITLE);
    expect(card?.textContent).toContain(WEATHER_BACKFILL_BODY);
  });

  it('S3: renders the learning card with the usable-day count', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      state: 'learning', fit: null, prediction: null, suggestion: null, usableDays: 9,
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-learning-card');
    expect(card?.textContent).toContain(composeLearningBody(9));
    expect(card?.querySelector('#weather-details-button')).not.toBeNull();
  });

  it('ready: renders the Tomorrow card with rows, verdict, and both actions', () => {
    const mount = mountIntoBody();
    const readout = buildReadout();
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-tomorrow-card');
    expect(card?.textContent).toContain(composeTomorrowTitle(2));
    expect(card?.textContent).toContain(WEATHER_SOURCE_FORECAST);
    expect(card?.textContent).toContain(formatKwhRange(38, 50));
    expect(card?.textContent).toContain(formatDailyKwh(48));
    expect(card?.textContent).toContain(formatDailyKwh(50));
    const verdict = resolveTomorrowVerdict({
      currentDailyBudgetKwh: 50, predictionKwh: 42.8, residualQ50: 0, residualQ80: 5, residualQ90: 7,
    });
    expect(verdict).not.toBeNull();
    expect(card?.querySelector('.weather-card__verdict')?.textContent).toBe(verdict?.text);
    expect(card?.querySelector('#weather-adjust-budget')).not.toBeNull();
    expect(card?.querySelector('#weather-details-button')).not.toBeNull();
  });

  it('S8: shows the Rough estimate chip with the colder-than-observed reason', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      prediction: {
        tempMeanC: -18,
        source: 'forecast',
        kwh: 68,
        lowKwh: 60,
        highKwh: 80,
        beyondObservedCold: true,
        beyondObservedWarm: false,
      },
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-tomorrow-card');
    expect(card?.querySelector('.plan-chip')?.textContent).toBe(WEATHER_CHIP_ROUGH_ESTIMATE);
    expect(card?.textContent).toContain(WEATHER_REASON_COLDER_THAN_OBSERVED);
  });

  it('navigates: Weather details requests the weather view, Adjust budget the adjust view', () => {
    const mount = mountIntoBody();
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, buildProps({ onLocalViewChange }));
    (mount.querySelector('#weather-details-button') as HTMLElement).click();
    expect(onLocalViewChange).toHaveBeenCalledWith('weather');
    (mount.querySelector('#weather-adjust-budget') as HTMLElement).click();
    expect(onLocalViewChange).toHaveBeenCalledWith('adjust');
  });
});

describe('WeatherInsightDetail (localView weather)', () => {
  it('renders the header headline, summary sentence, and numbers card', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildProps({ localView: 'weather' }));
    expect(mount.querySelector('.plan-hero__headline')?.textContent).toBe(WEATHER_INSIGHT_TITLE);
    expect(mount.querySelector('#budget-redesign-mode-toggle')?.textContent).toContain('Done');
    const summary = mount.querySelector('#weather-summary-card');
    expect(summary?.textContent).toContain(composeSummaryHeadline({
      baseLoadKwhPerDay: 23, slopeKwhPerDegree: 1.8, balancePointC: 13,
    }));
    expect(summary?.textContent).toContain(composeBasedOnDays(287));
    expect(summary?.textContent).toContain(composeYesterdayLine({
      kwhTotal: 47, tempMeanC: 3, deviationKwh: 1.2, typicalLowDeviation: -5, typicalHighDeviation: 7,
    }));
    expect(mount.querySelector('#weather-numbers-card')).not.toBeNull();
    expect(mount.querySelector('#weather-scatter-card')).not.toBeNull();
    expect(mount.querySelector('#weather-device-footer')).not.toBeNull();
  });

  it('S5: uncorrelated homes get the honest summary and no numbers card', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({ fit: buildFit({ model: 'uncorrelated', usableDays: 214 }) });
    renderBudgetOverview(mount, buildProps({ localView: 'weather', weatherInsight: { readout, fetchFailed: false } }));
    expect(mount.querySelector('#weather-summary-card')?.textContent)
      .toContain(composeUncorrelatedSummary(214));
    expect(mount.querySelector('#weather-numbers-card')).toBeNull();
    expect(mount.querySelector('#weather-coverage-band')).toBeNull();
    expect(mount.querySelector('#weather-scatter-card')).not.toBeNull();
  });

  it('S3: learning detail shows only the scatter card with the learning subtitle', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      state: 'learning', fit: null, prediction: null, suggestion: null, usableDays: 9,
    });
    renderBudgetOverview(mount, buildProps({ localView: 'weather', weatherInsight: { readout, fetchFailed: false } }));
    expect(mount.querySelector('#weather-summary-card')).toBeNull();
    expect(mount.querySelector('#weather-numbers-card')).toBeNull();
    expect(mount.querySelector('#weather-scatter-card')?.textContent)
      .toContain(WEATHER_SCATTER_SUBTITLE_LEARNING);
  });
});

describe('WeatherSettingsSection', () => {
  it('renders two native selects and reports changes', () => {
    const mount = mountIntoBody();
    const onOutdoorChange = vi.fn();
    renderWeatherSettingsSection(mount, {
      outdoorDeviceId: null,
      forecastDeviceId: null,
      devices: [
        { id: 'dev-a', label: 'Hall sensor (sensor)' },
        { id: 'dev-b', label: 'Yr forecast (sensor)' },
      ],
      onOutdoorChange,
      onForecastChange: () => {},
    });
    expect(mount.textContent).toContain(WEATHER_OUTDOOR_PICKER_LABEL);
    expect(mount.textContent).toContain(WEATHER_FORECAST_PICKER_LABEL);
    const outdoor = mount.querySelector('#weather-outdoor-select') as HTMLSelectElement;
    outdoor.value = 'dev-a';
    outdoor.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onOutdoorChange).toHaveBeenCalledWith('dev-a');
  });

  it('clears to structural absence when rendered with null props (flag off)', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      outdoorDeviceId: null,
      forecastDeviceId: null,
      devices: [],
      onOutdoorChange: () => {},
      onForecastChange: () => {},
    });
    expect(mount.querySelector('#weather-insight-settings')).not.toBeNull();
    renderWeatherSettingsSection(mount, null);
    expect(mount.querySelector('#weather-insight-settings')).toBeNull();
    expect(mount.childElementCount).toBe(0);
  });
});
