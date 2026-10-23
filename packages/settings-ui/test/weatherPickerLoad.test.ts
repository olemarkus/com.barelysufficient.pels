import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';

// The weather pickers' Homey device list loads with their sub-page, not at
// boot. A visit made before boot read the saved flag ran against the default
// (off) flag, so boot's read finishes that visit.

const buildDom = (weatherPageOpen: boolean): void => {
  document.body.innerHTML = `
    <section class="panel${weatherPageOpen ? '' : ' hidden'}" id="weather-panel" data-panel="weather">
      <div id="weather-insight-settings-mount"></div>
    </section>
  `;
};

const install = async (weatherPageOpen: boolean) => {
  vi.resetModules();
  buildDom(weatherPageOpen);
  const homey = installHomeyMock({ settings: { weather_advisor_settings: { enabled: true } } });
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  setHomeyClient(homey as never);
  const weather = await import('../src/ui/weatherInsight.ts');
  return { homey, weather };
};

const deviceListReads = (homey: MockHomeyClient): number => (
  homey.api.mock.calls.filter(([method, uri]) => method === 'GET' && uri === '/homey_devices').length
);

describe('weather picker device list', () => {
  afterEach(async () => {
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    document.body.innerHTML = '';
  });

  it('loads for a visit made before boot read the saved flag', async () => {
    const { homey, weather } = await install(true);
    await weather.refreshWeatherInsightOnWeatherPanel();
    expect(deviceListReads(homey)).toBe(0);

    await weather.initWeatherInsight();
    await vi.waitFor(() => expect(deviceListReads(homey)).toBe(1));
  });

  it('waits for the visit when the sub-page is closed at boot', async () => {
    const { homey, weather } = await install(false);
    await weather.initWeatherInsight();
    expect(deviceListReads(homey)).toBe(0);

    await weather.refreshWeatherInsightOnWeatherPanel();
    await vi.waitFor(() => expect(deviceListReads(homey)).toBe(1));
  });
});
