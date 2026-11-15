import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability, settleLiveFeed } from '../helpers/liveFeedSocketHarness';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { mockHomeyInstance } from '../mocks/homey';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';

/**
 * A Zaptec publishes `plugged_in_paused` both for a session PELS paused and for
 * one the car stopped itself, and resumes only the first. Its refusal of a
 * turn-on is the only place the difference reaches PELS. Observed on a Zaptec
 * Go whose car had finished: PELS asked it to turn on every hour and was
 * refused every time.
 */
const CAR_STOPPED = 'Failed to turn on the charger: Error: Device command rejected :  '
  + 'Charging is not Paused nor Scheduled; Resume command cannot be sent';
const ID = 'zaptec-target-power';

const logger = (): Logger => ({ log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/zaptec-car-stopped') });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });

async function start(device: HomeyDeviceLike = buildZaptecTargetPowerDevice()) {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
  await initWithLiveFeed(transport);
  await seedTransportDevices(transport, [device]);
  return transport;
}

async function refuseTurnOn(transport: ReturnType<typeof createTestDeviceTransport>, error: Error) {
  const put = vi.fn().mockRejectedValue(error);
  setRestClient({ get: vi.fn(), put });
  await expect(transport.setCapability(ID, 'evcharger_charging', true)).rejects.toThrow();
  return put;
}

const stateOf = (transport: ReturnType<typeof createTestDeviceTransport>) => (
  transport.getSnapshotByDeviceId(ID)?.evChargingState
);

describe('a Zaptec whose car stopped its session', () => {
  it('reads car-stopped after the car-stopped refusal, and sends no further turn-on', async () => {
    const transport = await start();
    expect(stateOf(transport)).toBe('plugged_in_paused');

    const put = await refuseTurnOn(transport, new HomeyHttpStatusError(500, CAR_STOPPED));

    expect(stateOf(transport)).toBe('plugged_in_car_stopped');
    await expect(transport.setCapability(ID, 'evcharger_charging', true)).rejects.toThrow('Device is not ready to start.');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['any other refusal', new HomeyHttpStatusError(500, 'Failed to turn on the charger: Error: timeout')],
    ['a write that got no answer', new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/x/capability/evcharger_charging')],
  ])('stays paused after %s', async (_case, error) => {
    const transport = await start();
    await refuseTurnOn(transport, error);
    expect(stateOf(transport)).toBe('plugged_in_paused');
  });

  it('keeps car-stopped across a full read that reports nothing newer', async () => {
    const device = buildZaptecTargetPowerDevice();
    const transport = await start(device);
    await refuseTurnOn(transport, new HomeyHttpStatusError(500, CAR_STOPPED));

    vi.setSystemTime(Date.now() + 60_000);
    await seedTransportDevices(transport, [device]);

    expect(stateOf(transport)).toBe('plugged_in_car_stopped');
  });

  it('gives the app its state back on a full read with a newer session report', async () => {
    const transport = await start();
    await refuseTurnOn(transport, new HomeyHttpStatusError(500, CAR_STOPPED));

    vi.setSystemTime(Date.now() + 60_000);
    await seedTransportDevices(transport, [buildZaptecTargetPowerDevice()]);

    expect(stateOf(transport)).toBe('plugged_in_paused');
  });

  it.each([
    ['the car asks again', 'evcharger_charging_state', 'plugged_in_charging', 'plugged_in_charging'],
    ['the car is unplugged', 'evcharger_charging_state', 'plugged_out', 'plugged_out'],
    // A report that leaves the state as it was still ends the car-stop: Homey
    // publishes no unchanged value, so the device must not keep reading it.
    ['the switch is reported', 'evcharger_charging', false, 'plugged_in_paused'],
  ])('ends when %s', async (_case, capabilityId, value, expected) => {
    const transport = await start();
    await refuseTurnOn(transport, new HomeyHttpStatusError(500, CAR_STOPPED));

    await emitCapability(ID, capabilityId, value);
    await settleLiveFeed();

    expect(stateOf(transport)).toBe(expected);
  });

  it('ends when PELS pauses the session itself, so a resume is tried again', async () => {
    const transport = await start();
    await refuseTurnOn(transport, new HomeyHttpStatusError(500, CAR_STOPPED));

    setRestClient({ get: vi.fn(), put: vi.fn().mockResolvedValue(undefined) });
    await transport.setCapability(ID, 'evcharger_charging', false);

    expect(stateOf(transport)).toBe('plugged_in_paused');
  });
});
