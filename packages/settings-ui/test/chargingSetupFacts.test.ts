import type { ChargingAccessStatus, ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));

const access: ChargingAccessStatus = { configured: true, state: 'ready' };
const car: ChargingCurrentRead = {
  deviceId: 'car', name: 'Family car', scope: 'vehicle',
  setup: { method: 'built_in', confirmation: 'none' },
  supportsAppAction: true, capabilityWritable: false, sharedInstallation: false, flowCheck: 'clear', flowNames: [],
  currentRoute: 'built_in', missingCompanion: 'none',
};
const confirmed: ChargingCurrentRead = { ...car, setup: { ...car.setup, confirmation: 'vehicle' } };

beforeEach(() => {
  vi.resetModules();
  callApi.mockReset();
});

const respondWith = (devices: ChargingCurrentRead[]) => {
  callApi.mockImplementation(async (_method: string, path: string) => (
    path === '/ui_charging_current' ? devices : access
  ));
};

test('does not invent missing consent before a successful read', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
  callApi.mockRejectedValue(new Error('Unavailable'));
  await expect(facts.loadChargingSetup()).rejects.toThrow('Unavailable');
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
});

test('tracks the saved vehicle consent without applying it to ordinary chargers', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  respondWith([car, { ...car, deviceId: 'charger', scope: 'charger' }]);
  await facts.loadChargingSetup();
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(true);
  expect(facts.vehicleChargingConsentMissing('charger')).toBe(false);

  respondWith([confirmed]);
  await facts.loadChargingSetup();
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
});

test.each(['/ui_charging_current', '/ui_charging_access'])('retains accepted consent facts when %s fails', async (failedPath) => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  respondWith([car]);
  await facts.loadChargingSetup();
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === failedPath) throw new Error('Setup unavailable');
    return path === '/ui_charging_current' ? [confirmed] : access;
  });
  await expect(facts.loadChargingSetup()).rejects.toThrow('Setup unavailable');
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(true);
});

test('a late read cannot undo a newer accepted consent choice', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  let finishOld!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(access)
    .mockResolvedValueOnce([confirmed])
    .mockResolvedValueOnce(access);
  const oldRead = facts.loadChargingSetup();
  await facts.loadChargingSetup();
  finishOld([car]);
  expect((await oldRead).devices).toEqual([confirmed]);
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
});

test('notifies changed facts and clears a prerequisite after a successful absent read', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  const changed = vi.fn();
  document.addEventListener(facts.CHARGING_SETUP_UPDATED, changed);
  try {
    respondWith([car]);
    await facts.loadChargingSetup();
    await facts.loadChargingSetup();
    expect(changed).toHaveBeenCalledOnce();
    respondWith([]);
    await facts.loadChargingSetup();
    expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    document.removeEventListener(facts.CHARGING_SETUP_UPDATED, changed);
  }
});


test('accepts a successful post-save read when a newer background read fails', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  respondWith([car]);
  await facts.loadChargingSetup();
  facts.invalidateChargingSetupReads();
  let finish!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(access);
  const savedRead = facts.loadChargingSetup();
  callApi.mockRejectedValueOnce(new Error('Background read failed')).mockResolvedValueOnce(access);
  await expect(facts.loadChargingSetup()).rejects.toThrow('Background read failed');
  finish([confirmed]);
  expect((await savedRead).devices).toEqual([confirmed]);
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
});

test('rejects a read started during a write after settlement even when the new read fails', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  respondWith([car]);
  await facts.loadChargingSetup();
  let finish!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(access);
  const duringWrite = facts.loadChargingSetup();
  facts.invalidateChargingSetupReads();
  callApi.mockRejectedValueOnce(new Error('Readback failed')).mockResolvedValueOnce(access);
  await expect(facts.loadChargingSetup()).rejects.toThrow('Readback failed');
  const stale = expect(duringWrite).rejects.toMatchObject({ name: 'ChargingSetupReadSupersededError' });
  finish([confirmed]);
  await stale;
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(true);
});

test('an unchanged newer read still protects its accepted generation', async () => {
  const facts = await import('../src/ui/chargingSetupFacts.ts');
  respondWith([confirmed]);
  await facts.loadChargingSetup();
  let finish!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(access);
  const oldRead = facts.loadChargingSetup();
  await facts.loadChargingSetup();
  finish([car]);
  expect((await oldRead).devices).toEqual([confirmed]);
  expect(facts.vehicleChargingConsentMissing(car.deviceId)).toBe(false);
});
