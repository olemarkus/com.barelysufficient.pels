import {
  composeDeviceFooter,
  composeForecastReadingLine,
  composeForecastSourceLine,
  composeOutdoorReadingLine,
} from '../../shared-domain/src/weatherInsightCopy';

describe('composeForecastSourceLine', () => {
  it('names a reporting forecast device', () => {
    expect(composeForecastSourceLine('forecast')).toBe('Forecast for tomorrow’s average');
  });

  it('says no device is set when none is configured', () => {
    expect(composeForecastSourceLine('recent_no_device')).toContain('no forecast device set');
  });

  it('distinguishes a configured-but-silent forecast device from no device', () => {
    const line = composeForecastSourceLine('recent_device_unreadable');
    expect(line).toContain('isn’t reporting');
    expect(line).not.toContain('no forecast device set');
  });
});

describe('composeDeviceFooter', () => {
  const base = {
    outdoorDeviceName: 'Outdoor sensor',
    outdoorDeviceConfigured: true,
    forecastDeviceName: 'Yr forecast',
    forecastStatus: 'forecast' as const,
  };

  it('shows both device names when each reports', () => {
    expect(composeDeviceFooter(base)).toBe('Temperature: Outdoor sensor · Forecast: Yr forecast');
  });

  it('says "not set" only when no outdoor device is configured', () => {
    expect(composeDeviceFooter({ ...base, outdoorDeviceName: null, outdoorDeviceConfigured: false }))
      .toContain('Temperature: not set');
  });

  it('says "not responding" for a configured outdoor device whose name could not be read', () => {
    const footer = composeDeviceFooter({ ...base, outdoorDeviceName: null, outdoorDeviceConfigured: true });
    expect(footer).toContain('Temperature: not responding');
    expect(footer).not.toContain('not set');
  });

  it('shows "none — using recent days" when no forecast device is configured', () => {
    expect(composeDeviceFooter({
      ...base, forecastDeviceName: null, forecastStatus: 'recent_no_device',
    })).toContain('Forecast: none — using recent days');
  });

  it('names a configured-but-silent forecast device as not reporting (never "none")', () => {
    const footer = composeDeviceFooter({ ...base, forecastStatus: 'recent_device_unreadable' });
    expect(footer).toContain('Forecast: Yr forecast isn’t reporting — using recent days');
    expect(footer).not.toContain('Forecast: none');
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

describe('composeForecastReadingLine', () => {
  it('shows tomorrow’s reading with an ok tone', () => {
    expect(composeForecastReadingLine({ status: 'reading', tempC: 2 }))
      .toEqual({ text: 'Reading tomorrow ≈ 2 °C', tone: 'ok' });
  });

  it('warns (and names the recent-days fallback) when the device is silent', () => {
    const line = composeForecastReadingLine({ status: 'unreadable' });
    expect(line?.tone).toBe('warn');
    expect(line?.text).toContain('recent days');
  });

  it('renders no line when no device is configured', () => {
    expect(composeForecastReadingLine({ status: 'no_device' })).toBeNull();
  });
});
