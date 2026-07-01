import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';
import {
  renderWeatherSettingsSection,
  type WeatherPickersProps,
} from '../src/ui/views/WeatherSettingsSection.tsx';
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
  WEATHER_DISABLED_PITCH,
  WEATHER_ENABLE_LABEL,
  WEATHER_ERROR_TITLE,
  WEATHER_INSIGHT_TITLE,
  WEATHER_LEARNING_STUCK,
  WEATHER_OUTDOOR_PICKER_LABEL,
  WEATHER_REASON_COLDER_THAN_OBSERVED,
  WEATHER_SCATTER_SUBTITLE_LEARNING,
  WEATHER_SETUP_BODY,
  WEATHER_SETUP_BUTTON,
  WEATHER_SOURCE_FORECAST,
  WEATHER_WARN_OVER_HARDCAP_TITLE,
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
  },
  forecastStatus: 'forecast',
  outdoorReading: { status: 'reading', tempC: 4 },
  dailyBudgetKwh: 50,
  dailyBudgetEnabled: true,
  autoApplyDailyBudget: false,
  lastAutoApply: null,
  fit: buildFit(),
  coverage: [
    { fromC: -10, toC: -5, days: 6, sufficient: false },
    { fromC: -5, toC: 0, days: 22, sufficient: true },
    { fromC: 0, toC: 5, days: 40, sufficient: true },
  ],
  prediction: {
    tempMeanC: 2,
    tempMinC: -4,
    tempMaxC: 6,
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
    split: null,
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
  onChartUnitChange: () => {},
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
    // Deep-links straight to the dedicated Weather insight sub-page.
    expect(button?.getAttribute('data-settings-target')).toBe('weather');
    // A daily budget is set (fixture: 50) → no budget nudge.
    expect(card?.querySelector('#weather-setup-budget-hint')).toBeNull();
  });

  it('S1: nudges to set a daily budget only when none is configured', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      state: 'needs_device', fit: null, prediction: null, suggestion: null, dailyBudgetKwh: null,
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const hint = mount.querySelector('#weather-setup-budget-hint');
    expect(hint?.textContent).toContain('daily budget');
  });

  it('S2: renders the backfilling card', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({ state: 'backfilling', fit: null, prediction: null, suggestion: null });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-backfill-card');
    expect(card?.textContent).toContain(WEATHER_BACKFILL_TITLE);
    expect(card?.textContent).toContain(WEATHER_BACKFILL_BODY);
    // Liveness cue so a slow first run doesn't read as a freeze.
    expect(card?.querySelector('md-circular-progress')).not.toBeNull();
  });

  it('S3: renders the learning card with the usable-day count (no stuck note while reading)', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      state: 'learning', fit: null, prediction: null, suggestion: null, usableDays: 9,
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-learning-card');
    expect(card?.textContent).toContain(composeLearningBody(9));
    expect(card?.querySelector('#weather-details-button')).not.toBeNull();
    expect(card?.querySelector('#weather-learning-stuck')).toBeNull();
  });

  it('S3: warns on the learning card when the outdoor device is unreadable (stuck learning)', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      state: 'learning', fit: null, prediction: null, suggestion: null, usableDays: 9,
      outdoorReading: { status: 'unreadable' },
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const stuck = mount.querySelector('#weather-learning-stuck');
    expect(stuck?.textContent).toContain(WEATHER_LEARNING_STUCK);
  });

  it('ready: renders the Tomorrow card with rows, verdict, and both actions', () => {
    const mount = mountIntoBody();
    const readout = buildReadout();
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout, fetchFailed: false } }));
    const card = mount.querySelector('#weather-tomorrow-card');
    expect(card?.textContent).toContain(composeTomorrowTitle(2));
    expect(card?.textContent).toContain(WEATHER_SOURCE_FORECAST);
    // Tomorrow's swing (producer-resolved low/high) renders.
    expect(card?.querySelector('#weather-tomorrow-lowhigh')?.textContent).toBe('Low −4 °C · High 6 °C');
    // MET Norway attribution (CC-BY) shows wherever the forecast is displayed.
    expect(card?.querySelector('#weather-tomorrow-attribution')?.textContent)
      .toContain('Weather data from MET Norway');
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

  it('only claims a "cold evening" in the tight verdict when one is actually forecast', () => {
    const tight = { currentDailyBudgetKwh: 40, predictionKwh: 38, residualQ50: 0, residualQ80: 5, residualQ90: 9 };
    // q50 ≤ budget < q80 → tight tier either way; the clause depends on the flag.
    expect(resolveTomorrowVerdict({ ...tight, coldEveningSuspected: true })?.text).toContain('cold evening');
    expect(resolveTomorrowVerdict({ ...tight, coldEveningSuspected: false })?.text).not.toContain('cold evening');
    expect(resolveTomorrowVerdict({ ...tight })?.text).not.toContain('cold evening'); // absent ⇒ neutral
    // Both stay warn-toned and never contradict the tier.
    expect(resolveTomorrowVerdict({ ...tight, coldEveningSuspected: true })?.tone).toBe('warn');
    expect(resolveTomorrowVerdict({ ...tight, coldEveningSuspected: false })?.tone).toBe('warn');
  });

  it('shows the auto-apply status line only when auto-apply is on AND the daily budget is on', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildProps({
      weatherInsight: { readout: buildReadout({ autoApplyDailyBudget: true, dailyBudgetEnabled: true }), fetchFailed: false },
    }));
    expect(mount.querySelector('#weather-auto-apply-status')).not.toBeNull();

    // Auto-apply on but budget off → inert, so the card must not claim PELS sets it daily.
    renderBudgetOverview(mount, buildProps({
      weatherInsight: { readout: buildReadout({ autoApplyDailyBudget: true, dailyBudgetEnabled: false }), fetchFailed: false },
    }));
    expect(mount.querySelector('#weather-auto-apply-status')).toBeNull();

    renderBudgetOverview(mount, buildProps({
      weatherInsight: { readout: buildReadout({ autoApplyDailyBudget: false }), fetchFailed: false },
    }));
    expect(mount.querySelector('#weather-auto-apply-status')).toBeNull();
  });

  it('shows the over-hard-cap warning banner only when the suggestion is capped by capacity', () => {
    const mount = mountIntoBody();
    const capped = buildReadout({
      suggestion: { kwh: 290, currentDailyBudgetKwh: 50, cappedByCapacity: true, budgetMayBeLimiting: false },
    });
    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout: capped, fetchFailed: false } }));
    const banner = mount.querySelector('#weather-overcap-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(WEATHER_WARN_OVER_HARDCAP_TITLE);
    // The cap is physical — the banner must never suggest raising it.
    expect(banner?.textContent?.toLowerCase()).not.toContain('raise');
    // A capacity-capped day is never an "ok" landing — the ok-tone verdict is
    // suppressed so it can't contradict the banner.
    expect(mount.querySelector('.weather-card__verdict--ok')).toBeNull();

    renderBudgetOverview(mount, buildProps({ weatherInsight: { readout: buildReadout(), fetchFailed: false } }));
    expect(mount.querySelector('#weather-overcap-banner')).toBeNull();
    // Uncapped: the ok verdict renders normally.
    expect(mount.querySelector('.weather-card__verdict--ok')).not.toBeNull();
  });

  it('S8: shows the Rough estimate chip with the colder-than-observed reason', () => {
    const mount = mountIntoBody();
    const readout = buildReadout({
      prediction: {
        tempMeanC: -18,
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
    const footer = mount.querySelector('#weather-device-footer');
    expect(footer).not.toBeNull();
    // The footer's forecast half is the MET Norway CC-BY attribution.
    expect(footer?.textContent).toContain('Weather data from MET Norway');
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
  const buildPickers = (overrides: Partial<WeatherPickersProps> = {}): WeatherPickersProps => ({
    outdoorDeviceId: null,
    devices: [{ id: 'dev-a', label: 'Hall sensor' }, { id: 'dev-b', label: 'Yr forecast' }],
    devicesLoaded: true,
    outdoorReading: { status: 'no_device' },
    onOutdoorChange: () => {},
    autoApplyDailyBudget: false,
    onAutoApplyChange: () => {},
    dailyBudgetEnabled: true,
    lastAutoApply: null,
    ...overrides,
  });

  it('renders the master switch and the off-state pitch when off (no pickers)', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, { enabled: false, onEnabledChange: () => {}, pickers: null });
    expect(mount.querySelector('#weather-enable-switch')).not.toBeNull();
    expect(mount.textContent).toContain(WEATHER_ENABLE_LABEL);
    // The off page sells the feature with a payoff-led pitch, not a bare toggle.
    expect(mount.querySelector('#weather-disabled-pitch')?.textContent).toContain(WEATHER_DISABLED_PITCH);
    // No pickers while the feature is off.
    expect(mount.querySelector('#weather-insight-settings')).toBeNull();
    expect(mount.querySelector('#weather-outdoor-select')).toBeNull();
  });

  it('toggling the master switch reports the new enabled state', () => {
    const mount = mountIntoBody();
    const onEnabledChange = vi.fn();
    renderWeatherSettingsSection(mount, { enabled: false, onEnabledChange, pickers: null });
    const sw = mount.querySelector('#weather-enable-switch') as HTMLElement & { selected: boolean };
    sw.selected = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('renders the outdoor select (no forecast picker) and reports changes when enabled', () => {
    const mount = mountIntoBody();
    const onOutdoorChange = vi.fn();
    renderWeatherSettingsSection(mount, {
      enabled: true, onEnabledChange: () => {}, pickers: buildPickers({ onOutdoorChange }),
    });
    expect(mount.querySelector('#weather-enable-switch')).not.toBeNull();
    expect(mount.textContent).toContain(WEATHER_OUTDOOR_PICKER_LABEL);
    // The forecast now comes from MET — no forecast device picker exists.
    expect(mount.querySelector('#weather-forecast-select')).toBeNull();
    const outdoor = mount.querySelector('#weather-outdoor-select') as HTMLSelectElement;
    outdoor.value = 'dev-a';
    outdoor.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onOutdoorChange).toHaveBeenCalledWith('dev-a');
  });

  it('shows the outdoor live validity line (ok reading vs warn unreadable)', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({
        outdoorDeviceId: 'dev-a',
        outdoorReading: { status: 'reading', tempC: 4 },
      }),
    });
    expect(mount.querySelector('.weather-picker-status--ok')?.textContent).toContain('Reading 4 °C now');

    // Unreadable outdoor device → the warn line reuses .field__hint--alert.
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ outdoorDeviceId: 'dev-a', outdoorReading: { status: 'unreadable' } }),
    });
    expect(mount.querySelector('.field__hint--alert')?.textContent).toContain('can’t read a temperature');
  });

  it('labels a configured-but-deleted device as no-longer-available, never the raw id', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      // loaded, and the configured device isn't in the list → deleted
      pickers: buildPickers({ outdoorDeviceId: 'homey:device:deleted-uuid', devices: [{ id: 'dev-a', label: 'Hall sensor' }] }),
    });
    const outdoor = mount.querySelector('#weather-outdoor-select') as HTMLSelectElement;
    const orphan = [...outdoor.options].find((o) => o.value === 'homey:device:deleted-uuid');
    expect(orphan?.textContent).toContain('no longer available');
    expect(orphan?.textContent).not.toContain('homey:device:deleted-uuid');
  });

  it('uses a neutral placeholder for a configured device while the list is still loading', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      // not loaded yet → don't claim "deleted"
      pickers: buildPickers({ outdoorDeviceId: 'homey:device:loading-uuid', devices: [], devicesLoaded: false }),
    });
    const outdoor = mount.querySelector('#weather-outdoor-select') as HTMLSelectElement;
    const opt = [...outdoor.options].find((o) => o.value === 'homey:device:loading-uuid');
    expect(opt?.textContent).toBe('Selected device');
    expect(opt?.textContent).not.toContain('no longer available');
  });

  it('shows an empty state when loaded with no temperature devices', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ devices: [], devicesLoaded: true }),
    });
    expect(mount.querySelector('#weather-no-devices')?.textContent).toContain('no temperature devices');
  });

  it('swaps pickers for the pitch when re-rendered disabled, keeping the master switch', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, { enabled: true, onEnabledChange: () => {}, pickers: buildPickers() });
    expect(mount.querySelector('#weather-insight-settings')).not.toBeNull();
    expect(mount.querySelector('#weather-disabled-pitch')).toBeNull();
    renderWeatherSettingsSection(mount, { enabled: false, onEnabledChange: () => {}, pickers: null });
    expect(mount.querySelector('#weather-insight-settings')).toBeNull();
    expect(mount.querySelector('#weather-disabled-pitch')).not.toBeNull();
    expect(mount.querySelector('#weather-enable-switch')).not.toBeNull();
  });

  it('renders the auto-apply switch and reports toggles', () => {
    const mount = mountIntoBody();
    const onAutoApplyChange = vi.fn();
    renderWeatherSettingsSection(mount, {
      enabled: true, onEnabledChange: () => {}, pickers: buildPickers({ onAutoApplyChange }),
    });
    const sw = mount.querySelector('#weather-auto-apply-switch') as HTMLElement & { selected: boolean };
    expect(sw).not.toBeNull();
    sw.selected = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onAutoApplyChange).toHaveBeenCalledWith(true);
  });

  it('shows the inert hint only when auto-apply is on but the daily budget is off', () => {
    const mount = mountIntoBody();
    // On + budget off → hint shows.
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ autoApplyDailyBudget: true, dailyBudgetEnabled: false }),
    });
    expect(mount.querySelector('#weather-auto-apply-needs-budget')).not.toBeNull();
    // On + budget on → no hint.
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ autoApplyDailyBudget: true, dailyBudgetEnabled: true }),
    });
    expect(mount.querySelector('#weather-auto-apply-needs-budget')).toBeNull();
    // Off + budget off → no hint (don't nag before they opt in).
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ autoApplyDailyBudget: false, dailyBudgetEnabled: false }),
    });
    expect(mount.querySelector('#weather-auto-apply-needs-budget')).toBeNull();
  });

  it('shows the last-applied line when an auto-apply has happened', () => {
    const mount = mountIntoBody();
    renderWeatherSettingsSection(mount, {
      enabled: true,
      onEnabledChange: () => {},
      pickers: buildPickers({ lastAutoApply: { dateKey: '2026-06-12', kwh: 44 } }),
    });
    const last = mount.querySelector('#weather-auto-apply-last');
    expect(last?.textContent).toContain('Last applied');
    expect(last?.textContent).toContain('44 kWh');
  });
});
