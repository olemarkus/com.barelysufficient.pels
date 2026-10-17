import { SteppedLoadRequestTimeoutError } from '../../lib/ports/steppedLoadWrite';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { ChargingCurrentControl } from '../../lib/device/chargingCurrentControl';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';

const selected: ChargingCurrentSetup = { method: 'built_in', confirmation: 'single_charger' };
const zaptec = (writable = false): HomeyDeviceLike => ({ id: 'charger', name: 'Zaptec', class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go2', data: { id: 'zaptec-id', installationId: 'installation' },
  capabilities: ['available_installation_current'], capabilitiesObj: { available_installation_current: { value: 16, setable: writable } } });
const futurehome = (): HomeyDeviceLike => ({ id: 'futurehome', name: 'Futurehome', class: 'evcharger',
  driverId: 'homey:app:no.futurehome:ev_charger', settings: { currentLimit: 16 },
  capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'] });
function fixture(device = zaptec()) {
  const values = new Map<string, unknown>();
  const settings = { get: (key: string) => values.get(key), getKeys: () => [...values.keys()],
    set: (key: string, value: unknown) => { values.set(key, value); }, unset: (key: string) => { values.delete(key); } };
  const inventory = [device];
  const get = vi.fn(async (_path: string): Promise<unknown> => ({}));
  setRestClient({ get, put: vi.fn() });
  const control = new ChargingCurrentControl({ settings, api: { getLocalUrl: async () => 'http://homey.local' },
    cloud: { getHomeyId: async () => 'test' } },
  { structuredLog: getLogger('test') }, () => inventory, () => ({ connected: true, revision: 0 }));
  const access = control.access;
  return { inventory, control, access, get, values };
}
const response = (body: unknown) => ({ status: 200, ok: true, headers: { get: () => 'test' }, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

test('prefers a writable current capability without requiring an API key', async () => {
  const { control } = fixture(zaptec(true));
  await control.save('charger', selected);
  const write = vi.fn();
  await control.writeCurrent(zaptec(true), 10, write);
  expect(write).toHaveBeenCalledExactlyOnceWith('available_installation_current', 10);
});

test('key-only setup preserves the Flow route until explicitly selected', async () => {
  const { control, access } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow'] })));
  await access.save({ key: 'private-key' });
  expect(control.setup('charger').method).toBe('flow');
});

test('uses the exact installed app action and all three installation-current arguments', async () => {
  const { control, access, get } = fixture();
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  await access.save({ key: 'private-key' });
  await control.save('charger', selected);
  get.mockResolvedValue([{ id: 'homey:app:com.zaptec:go2_installation_current_control' }]);
  const capabilityWrite = vi.fn();
  await control.writeCurrent(zaptec(), 10, capabilityWrite);
  expect(capabilityWrite).not.toHaveBeenCalled();
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ args: {
    device: { id: 'charger' }, current1: 10, current2: 10, current3: 10,
  } });
});

test('refuses an installation-wide command when another charger is discovered', async () => {
  const { control, inventory } = fixture(zaptec(true));
  await control.save('charger', selected);
  inventory.push({ ...zaptec(true), id: 'second-charger' });
  const write = vi.fn();
  await expect(control.writeCurrent(zaptec(true), 10, write)).rejects.toThrow('single-charger');
  expect(write).not.toHaveBeenCalled();
});

test('requires explicit single-charger confirmation even with only one device in inventory', async () => {
  const { control } = fixture(zaptec(true));
  await expect(control.save('charger', { ...selected, confirmation: 'none' })).rejects.toThrow('single-charger');
});

test.each(['ordinary', 'advanced'])('finds a current-setting app action in an enabled %s Flow', async (kind) => {
  const { control, get } = fixture(zaptec(true));
  const card = { id: 'homey:app:com.zaptec:go2_installation_current_control', args: { device: { id: 'charger' } } };
  get.mockImplementation(async (path) => {
    if (kind === 'ordinary' && path === 'manager/flow/flow/') return { bridge: { name: 'Current bridge', actions: [card] } };
    if (kind === 'advanced' && path === 'manager/flow/advancedflow/') return { bridge: { name: 'Current bridge', cards: { action: { ...card, type: 'action' } } } };
    return {};
  });
  expect((await control.list())[0]).toMatchObject({ flowCheck: 'conflict', flowNames: ['Current bridge'] });
  await expect(control.save('charger', selected)).rejects.toThrow('Remove');
});

test('unreadable Flow inventory cannot enable built-in control', async () => {
  const { control, get } = fixture(zaptec(true)); get.mockRejectedValue(new Error('unavailable'));
  await expect(control.save('charger', selected)).rejects.toThrow('check again');
});

test('a battery-level reporting Flow does not block current control', async () => {
  const { control, get } = fixture(zaptec(true));
  get.mockImplementation(async (path) => path === 'manager/flow/flow/' ? {
    soc: { actions: [{ id: 'homey:app:com.barelysufficient.pels:report_evcharger_battery_level', args: { device: { id: 'charger' } } }] },
  } : {});
  await expect(control.save('charger', selected)).resolves.toBeUndefined();
});

test.each(['missing key', 'conflicting Flow', 'unreadable Flows'])('Tesla control can be revoked with %s', async (failure) => {
  const tesla: HomeyDeviceLike = { id: 'tesla', name: 'Tesla', class: 'sensor',
    driverId: 'homey:app:com.tesla.car:battery',
    capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'] };
  const { control, access, get } = fixture(tesla);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow'] })));
  await access.save({ key: 'private-key' });
  await control.save('tesla', { method: 'built_in', confirmation: 'vehicle' });
  if (failure === 'missing key') access.remove();
  else if (failure === 'unreadable Flows') get.mockRejectedValue(new Error('Unavailable'));
  else get.mockImplementation(async (path) => path === 'manager/flow/flow/' ? {
    bridge: { actions: [{ id: 'homey:device:tesla:charge_current' }] },
  } : {});
  await control.save('tesla', { method: 'built_in', confirmation: 'none' });
  expect(control.setup('tesla')).toEqual({ method: 'built_in', confirmation: 'none' });
  expect(() => control.assertControlAllowed(tesla)).toThrow('confirmed stationary AC charging session');
  await expect(control.save('tesla', { method: 'built_in', confirmation: 'vehicle' })).rejects.toThrow();
});


test.each([false, true])('current timeout preserves its actual writable=%s route', async (writable) => {
  const { control, access, get } = fixture(zaptec(writable));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow'] })));
  await access.save({ key: 'private-key' });
  await control.save('charger', selected);
  get.mockResolvedValue([{ id: 'homey:app:com.zaptec:go2_installation_current_control' }]);
  const timeout = new HomeyRequestTimeoutError('POST', '/api/manager/flow/flowcardaction/current/run');
  vi.spyOn(access, 'runCurrentAction').mockRejectedValue(timeout);
  const capabilityWrite = vi.fn().mockRejectedValue(timeout);
  const command = control.writeCurrent(zaptec(writable), 10, capabilityWrite);
  if (writable) {
    await expect(command).rejects.toBe(timeout);
    expect(access.runCurrentAction).not.toHaveBeenCalled();
  } else {
    await expect(command).rejects.toBeInstanceOf(SteppedLoadRequestTimeoutError);
    await expect(command).rejects.toMatchObject({ transport: 'homey_action', cause: timeout });
    expect(capabilityWrite).not.toHaveBeenCalled();
  }
});

test('a Futurehome charger runs its own current-limit action with no capability and no scope confirmation', async () => {
  const { control, access, get } = fixture(futurehome());
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  expect((await control.list())[0]).toMatchObject({ scope: 'charger', capabilityWritable: false, flowCheck: 'clear' });
  await access.save({ key: 'private-key' });
  await expect(control.save('futurehome', { method: 'built_in', confirmation: 'single_charger' }))
    .rejects.toThrow('Confirm the control scope');
  await control.save('futurehome', { method: 'built_in', confirmation: 'none' });
  get.mockResolvedValue([{ id: 'homey:device:futurehome:currentLimit' }]);
  const capabilityWrite = vi.fn();
  await expect(control.writeCurrent(futurehome(), 10, capabilityWrite)).resolves.toBe('homey_action');
  expect(capabilityWrite).not.toHaveBeenCalled();
  expect(String(fetchMock.mock.calls[1]![0])).toContain('homey%3Adevice%3Afuturehome%3AcurrentLimit');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ args: { value: 10 } });
});

test('a Futurehome current-limit action in a Flow blocks built-in control', async () => {
  const { control, get } = fixture(futurehome());
  get.mockImplementation(async (path) => path === 'manager/flow/flow/'
    ? { limit: { name: 'Charger limit', actions: [{ id: 'homey:device:futurehome:currentLimit' }] } } : {});
  expect((await control.list())[0]).toMatchObject({ flowCheck: 'conflict', flowNames: ['Charger limit'] });
});
