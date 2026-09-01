import { describe, expect, it, vi } from 'vitest';
import { BackgroundTasksController } from '../../setup/backgroundTasksController';
import { TeardownRegistry } from '../../lib/utils/teardownRegistry';
import { partialDouble } from '../helpers/partialDouble';
import type { BackgroundTasksControllerDeps } from '../../setup/backgroundTasksController';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';

/**
 * `WeatherCollector.start()` returns `() => this.stop()` — a closure over the
 * SAME instance, not over that run's resources. A controller that starts the
 * replacement before stopping the predecessor therefore tears down the run it
 * just began, and the collector stays dead for the rest of the process.
 */
const buildCollectorDouble = (): { collector: WeatherCollector; isRunning: () => boolean } => {
  let running = false;
  const stop = (): void => { running = false; };
  const collector = partialDouble<WeatherCollector>({
    start: () => {
      stop();
      running = true;
      return stop;
    },
  });
  return { collector, isRunning: () => running };
};

const buildController = (teardown: TeardownRegistry): BackgroundTasksController => (
  new BackgroundTasksController(partialDouble<BackgroundTasksControllerDeps>({ teardown }))
);

describe('BackgroundTasksController teardown ordering', () => {
  it('leaves the weather collector RUNNING after a restart with the same instance', () => {
    const teardown = new TeardownRegistry();
    const controller = buildController(teardown);
    const { collector, isRunning } = buildCollectorDouble();

    controller.startWeatherCollector(collector);
    expect(isRunning()).toBe(true);

    // The reload path (`AppRuntimeApi.reloadWeatherCollector`) hands back the
    // same collector object on every weather-settings change.
    controller.startWeatherCollector(collector);
    expect(isRunning()).toBe(true);

    controller.startWeatherCollector(collector);
    expect(isRunning()).toBe(true);
  });

  it('stops the collector on teardown', () => {
    const teardown = new TeardownRegistry();
    const controller = buildController(teardown);
    const { collector, isRunning } = buildCollectorDouble();

    controller.startWeatherCollector(collector);
    controller.stopAll();
    expect(isRunning()).toBe(false);
  });

  it('holds nothing when there is no collector, and still stops a previous one', () => {
    const teardown = new TeardownRegistry();
    const controller = buildController(teardown);
    const { collector, isRunning } = buildCollectorDouble();

    controller.startWeatherCollector(collector);
    controller.startWeatherCollector(undefined);
    expect(isRunning()).toBe(false);
    expect(teardown.has('weatherCollector')).toBe(false);
  });

  it('stopAll is idempotent', () => {
    const teardown = new TeardownRegistry();
    const controller = buildController(teardown);
    const stop = vi.fn();
    teardown.register('perfLog', stop);

    controller.stopAll();
    controller.stopAll();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
