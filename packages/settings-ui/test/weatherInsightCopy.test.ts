import {
  composeDeviceFooter,
  composeForecastSourceLine,
  composeOutdoorReadingLine,
  composeTomorrowLowHigh,
  WEATHER_ATTRIBUTION_MET,
} from '../../shared-domain/src/weatherInsightCopy';

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
