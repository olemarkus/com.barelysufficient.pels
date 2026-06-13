import {
  composeDeviceFooter,
  composeForecastSourceLine,
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
