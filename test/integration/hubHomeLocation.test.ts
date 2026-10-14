import { HubHomeLocation } from '../../lib/device/hubHomeLocation';
import { HOMEY_LOCATION_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';

const now = Date.parse('2026-10-14T10:00:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

function hubWith(get: (path: string) => Promise<unknown>) {
  const spy = vi.fn(get);
  setRestClient({ get: spy, put: vi.fn() });
  return { location: new HubHomeLocation(), get: spy };
}

test('has no home until the owner Web API answers, then reads the wrapped coordinates', async () => {
  const { location, get } = hubWith(async () => ({ value: { latitude: 60, longitude: 10, accuracy: 10 } }));
  expect(location.coordinates()).toBeUndefined();
  await location.refreshIfDue();
  expect(location.coordinates()).toEqual({ latitude: 60, longitude: 10 });
  expect(get).toHaveBeenCalledWith(HOMEY_LOCATION_API_PATH);
});

test('keeps the last accepted home through failed and empty reads', async () => {
  const answers: Array<() => Promise<unknown>> = [
    async () => ({ value: { latitude: 60, longitude: 10 } }),
    async () => { throw new Error('API unavailable'); },
    async () => ({ value: { latitude: 0, longitude: 0 } }),
  ];
  const { location, get } = hubWith(() => answers.shift()!());
  await location.refreshIfDue();
  for (let read = 2; read <= 3; read += 1) {
    vi.advanceTimersByTime(6 * 60 * 60_000);
    await location.refreshIfDue();
    expect(get).toHaveBeenCalledTimes(read);
    expect(location.coordinates()).toEqual({ latitude: 60, longitude: 10 });
  }
});

test('retries a failed first read after a minute and refreshes a good one only every six hours', async () => {
  const answers: Array<() => Promise<unknown>> = [
    async () => { throw new Error('REST client not initialized'); },
    async () => ({ value: { latitude: 60, longitude: 10 } }),
  ];
  const { location, get } = hubWith(() => answers.shift()!());
  await location.refreshIfDue();
  await location.refreshIfDue();
  expect(get).toHaveBeenCalledTimes(1);
  expect(location.coordinates()).toBeUndefined();
  vi.advanceTimersByTime(60_000);
  await location.refreshIfDue();
  expect(location.coordinates()).toEqual({ latitude: 60, longitude: 10 });
  vi.advanceTimersByTime(60 * 60_000);
  await location.refreshIfDue();
  expect(get).toHaveBeenCalledTimes(2);
});
