import {
  composeBudgetLimitingReason,
  composeDeviceFooter,
  composeForecastSourceLine,
  composeOutdoorReadingLine,
  composeTomorrowLowHigh,
  WEATHER_ATTRIBUTION_MET,
  WEATHER_REASON_BUDGET_LIMITING,
  WEATHER_REASON_RECENT_DEMAND,
  WEATHER_WARN_OVER_HARDCAP_BODY,
} from '../../shared-domain/src/weatherInsightCopy';

describe('composeBudgetLimitingReason', () => {
  it('states plainly that the budget has been limiting, without claiming cold weather', () => {
    // Golden assertion: the trigger is no longer temperature-gated, so the
    // sentence must not say "cold days" as it used to.
    expect(WEATHER_REASON_BUDGET_LIMITING).toBe(
      'Your budget has recently been limiting your devices, so the suggestion is raised to match.',
    );
    expect(composeBudgetLimitingReason(0)).toBe(WEATHER_REASON_BUDGET_LIMITING);
  });

  it('names the pressure contribution as part of the suggestion', () => {
    // The contribution may exceed the visible increase over the current budget.
    expect(composeBudgetLimitingReason(7)).toBe(
      'Your budget has recently been limiting your devices, so the suggestion is raised to match.'
      + ' 7.0 kWh of the suggestion covers recent demand beyond your budget.',
    );
  });

  it('explains a correction without a recent limit neutrally, saying it once', () => {
    // The correction may come from overshoot, held-back heater demand or a
    // budget-caused smart-task miss, so the line must not name one of them.
    expect(composeBudgetLimitingReason(7, false)).toBe(
      'The suggestion includes 7.0 kWh of extra room based on recent demand.',
    );
    expect(composeBudgetLimitingReason(0.5, false)).toBe(WEATHER_REASON_RECENT_DEMAND);
    expect(WEATHER_REASON_RECENT_DEMAND).toBe(
      'The suggestion includes extra room based on recent demand.',
    );
    for (const line of [composeBudgetLimitingReason(7, false), WEATHER_REASON_RECENT_DEMAND]) {
      expect(line).not.toContain('went over');
      expect(line).not.toContain('limiting your devices');
      expect(line).not.toContain('more than your budget');
    }
  });

  it('uses no em-dashes in the budget reason lines or the over-cap body', () => {
    for (const line of [
      composeBudgetLimitingReason(7), composeBudgetLimitingReason(7, false),
      composeBudgetLimitingReason(0, false), WEATHER_WARN_OVER_HARDCAP_BODY,
    ]) expect(line).not.toContain('—');
    expect(WEATHER_WARN_OVER_HARDCAP_BODY).toContain('limited in the coldest hours');
  });

  it('drops a contribution too small to act on, and never renders a junk number', () => {
    expect(composeBudgetLimitingReason(0.9)).toBe(WEATHER_REASON_BUDGET_LIMITING);
    expect(composeBudgetLimitingReason(Number.NaN)).toBe(WEATHER_REASON_BUDGET_LIMITING);
    expect(composeBudgetLimitingReason(Number.POSITIVE_INFINITY)).toBe(WEATHER_REASON_BUDGET_LIMITING);
  });
});

describe('composeForecastSourceLine', () => {
  it('names the MET forecast for a real prediction', () => {
    expect(composeForecastSourceLine('forecast')).toBe('Forecast for tomorrow’s average');
  });

  it('names the recent-days fallback when MET is unavailable', () => {
    const line = composeForecastSourceLine('recent_days');
    expect(line).toContain('recent weather');
    expect(line).not.toContain('forecast device');
  });
});

describe('composeDeviceFooter', () => {
  const base = {
    outdoorDeviceName: 'Outdoor sensor',
    outdoorDeviceConfigured: true,
    forecastFromMet: true,
  };

  it('shows the outdoor device name and the MET attribution', () => {
    expect(composeDeviceFooter(base)).toBe(`Temperature: Outdoor sensor · ${WEATHER_ATTRIBUTION_MET}`);
  });

  it('carries the MET attribution when the forecast is MET-backed (CC-BY requirement)', () => {
    expect(composeDeviceFooter(base)).toContain('Weather data from MET Norway');
  });

  it('shows a recent-days note (NOT a false MET credit) when MET is unavailable', () => {
    const footer = composeDeviceFooter({ ...base, forecastFromMet: false });
    expect(footer).not.toContain('MET Norway');
    expect(footer).toContain('Forecast: recent days');
  });

  it('says "not set" only when no outdoor device is configured', () => {
    expect(composeDeviceFooter({ outdoorDeviceName: null, outdoorDeviceConfigured: false, forecastFromMet: true }))
      .toContain('Temperature: not set');
  });

  it('says "not responding" for a configured outdoor device whose name could not be read', () => {
    const footer = composeDeviceFooter({ outdoorDeviceName: null, outdoorDeviceConfigured: true, forecastFromMet: true });
    expect(footer).toContain('Temperature: not responding');
    expect(footer).not.toContain('not set');
  });
});

describe('composeTomorrowLowHigh', () => {
  it('formats whole °C with the typographic minus', () => {
    expect(composeTomorrowLowHigh(-4, 6)).toBe('Low −4 °C · High 6 °C');
  });

  it('rounds to whole degrees', () => {
    expect(composeTomorrowLowHigh(-3.6, 5.4)).toBe('Low −4 °C · High 5 °C');
  });
});

describe('composeOutdoorReadingLine', () => {
  it('shows the live reading with an ok tone', () => {
    expect(composeOutdoorReadingLine({ status: 'reading', tempC: 4 }))
      .toEqual({ text: 'Reading 4 °C now', tone: 'ok' });
  });

  it('warns when a configured device cannot be read', () => {
    const line = composeOutdoorReadingLine({ status: 'unreadable' });
    expect(line?.tone).toBe('warn');
    expect(line?.text).toContain('can’t read a temperature');
  });

  it('renders no line when no device is configured', () => {
    expect(composeOutdoorReadingLine({ status: 'no_device' })).toBeNull();
  });
});
