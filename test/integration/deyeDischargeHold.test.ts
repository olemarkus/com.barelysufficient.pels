import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMainDischargeHold, DEYE_DISCHARGE_HOLD_OFFERED_KEY, DeyeDischargeHold } from '../../lib/executor/deyeDischargeHold';
import { DEYE_DISCHARGE_HOLD_KEY } from '../../lib/executor/deyeDischargeHoldRecord';

const SETUP = {
  region: 'eu', appId: 'developer-id', appSecret: 'private-app-secret', email: 'owner@example.com',
  password: 'private-password', deviceSn: 'example-inverter', acknowledgeRisk: true,
};

function harness() {
  const stored = new Map<string, unknown>();
  const settings = {
    get: (key: string) => stored.get(key),
    getKeys: () => [...stored.keys()],
    set: (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
    unset: (key: string) => { stored.delete(key); },
  };
  const authorize = vi.fn(async () => {});
  const submitLimit = vi.fn(async (_credentials: unknown, _amps: number) => '999999999999999999');
  const cloud = {
    authorize,
    submitLimit,
    readLimit: vi.fn(async () => 60),
    prepareLimitWrite: vi.fn(async (credentials: unknown, amps: number) => {
      await authorize();
      return async () => ({ kind: 'submitted' as const, orderId: await submitLimit(credentials, amps) });
    }),
    readOrder: vi.fn(async (_credentials: unknown, _id: string): Promise<'pending' | 'succeeded' | 'failed'> => 'succeeded'),
  };
  const owner = new DeyeDischargeHold(settings, cloud);
  return { stored, settings, cloud, owner };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const poll = () => vi.advanceTimersByTimeAsync(60_000);

describe('Deye EV discharge hold recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps app settings reads off the meter-driven lane', async () => {
    const { owner, settings } = harness();
    const keys = vi.spyOn(settings, 'getKeys');
    owner.start();
    await settle();
    expect(keys).toHaveBeenCalledTimes(1);
    expect(owner.hasWork(true)).toBe(false);
    owner.apply(true, () => true);
    owner.apply(false, () => false);
    await poll();
    expect(keys).toHaveBeenCalledTimes(1);
    owner.stop();
  });

  it('waits for the hold and its readback before writing and verifying the exact saved limit', async () => {
    const { cloud, owner, stored } = harness();
    await owner.save(SETUP);
    owner.start();
    cloud.submitLimit.mockImplementation(async (_credentials, amps) => {
      expect(stored.get(DEYE_DISCHARGE_HOLD_KEY)).toMatchObject({ claim: {
        originalLimitA: 60,
        step: { kind: 'submitting', direction: amps === 0 ? 'hold' : 'restore' },
      } });
      return amps === 0 ? '11' : '12';
    });
    owner.apply(true, () => true);
    await settle();
    expect(owner.status()).toMatchObject({ state: 'pending', orderId: '11', originalLimitA: 60 });
    owner.apply(false, () => false);
    cloud.readOrder.mockResolvedValue('pending');
    await settle();
    await poll();
    expect(cloud.submitLimit.mock.calls.map(([, amps]) => amps)).toEqual([0]);

    cloud.readOrder.mockResolvedValue('succeeded');
    await poll();
    await poll();
    expect(owner.status()).toMatchObject({ state: 'pending', orderId: '11' });
    expect(cloud.submitLimit).toHaveBeenCalledTimes(1);

    cloud.readLimit.mockResolvedValue(0);
    await poll();
    await poll();
    expect(cloud.submitLimit.mock.calls.map(([, amps]) => amps)).toEqual([0, 60]);
    await poll();
    await poll();
    expect(owner.status()).toMatchObject({ state: 'pending', orderId: '12' });
    cloud.readLimit.mockResolvedValue(60);
    await poll();
    expect(owner.status()).toEqual({
      enabled: true, offered: true, state: 'ready', deviceSn: SETUP.deviceSn, region: 'eu',
    });
    owner.stop();
  });

  it('restores an interrupted hold write after a restart without waiting for the owner', async () => {
    const { cloud, owner, settings } = harness();
    await owner.save(SETUP);
    cloud.submitLimit.mockRejectedValueOnce(new Error('connection lost'));
    owner.start();
    owner.apply(true, () => true);
    await settle();
    owner.stop();
    const recovered = new DeyeDischargeHold(settings, cloud);
    recovered.start();
    await settle();
    expect(cloud.submitLimit.mock.calls.map(([, amps]) => amps)).toEqual([0, 60]);
    expect(recovered.status()).toMatchObject({ state: 'pending', originalLimitA: 60 });
    await poll();
    await poll();
    expect(recovered.status()).toEqual({
      enabled: true, offered: true, state: 'ready', deviceSn: SETUP.deviceSn, region: 'eu',
    });
    recovered.stop();
  });

  it('asks the owner about an interrupted hold that is still wanted, then restores once it is not', async () => {
    const { cloud, owner } = harness();
    await owner.save(SETUP);
    cloud.submitLimit.mockRejectedValueOnce(new Error('connection lost'));
    owner.start();
    owner.apply(true, () => true);
    await settle();
    await poll();
    expect(owner.status()).toEqual({
      enabled: true, offered: true, state: 'recovery_required', deviceSn: SETUP.deviceSn, originalLimitA: 60,
      region: 'eu',
    });
    expect(cloud.submitLimit).toHaveBeenCalledTimes(1);
    await expect(owner.save({ ...SETUP, deviceSn: 'different-device' })).rejects.toThrow('same inverter');
    await expect(owner.acknowledge({})).rejects.toThrow('Confirm');
    cloud.readLimit.mockResolvedValue(0);
    await expect(owner.acknowledge({ confirmedOrderSettled: true })).rejects.toThrow('different discharge limit');

    owner.apply(false, () => false);
    await settle();
    expect(cloud.submitLimit.mock.calls.map(([, amps]) => amps)).toEqual([0, 60]);
    owner.stop();
  });

  it('restores a confirmed hold on startup even if a new booking is already driving', async () => {
    const { cloud, owner, settings } = harness();
    await owner.save(SETUP);
    owner.start();
    owner.apply(true, () => true);
    await settle();
    cloud.readLimit.mockResolvedValue(0);
    await poll();
    await poll();
    expect(owner.status().state).toBe('held');
    owner.stop();

    const recovered = new DeyeDischargeHold(settings, cloud);
    recovered.start();
    recovered.apply(true, () => true);
    await settle();
    expect(cloud.submitLimit.mock.calls.map(([, amps]) => amps)).toEqual([0, 60]);
    recovered.stop();
  });

  it('keeps the saved limit for manual recovery when a different nonzero limit is observed', async () => {
    const { cloud, owner } = harness();
    await owner.save(SETUP);
    owner.start();
    owner.apply(true, () => true);
    await settle();
    cloud.readLimit.mockResolvedValue(0);
    await poll();
    await poll();
    cloud.readLimit.mockResolvedValue(35);
    owner.apply(false, () => false);
    await settle();
    expect(cloud.submitLimit).toHaveBeenCalledTimes(1);
    expect(owner.status()).toMatchObject({ state: 'recovery_required', originalLimitA: 60 });
    await expect(owner.acknowledge({ confirmedOrderSettled: true })).rejects.toThrow('different discharge limit');
    cloud.readLimit.mockResolvedValue(60);
    await expect(owner.acknowledge({ confirmedOrderSettled: true })).resolves.toMatchObject({ state: 'disabled' });
    expect(cloud.submitLimit).toHaveBeenCalledTimes(1);
    owner.stop();
  });

  it('refuses a new hold if the plan becomes ineligible before the cloud write', async () => {
    const { cloud, owner } = harness();
    await owner.save(SETUP);
    let live = true;
    cloud.authorize.mockImplementation(async () => { live = false; });
    owner.start();
    owner.apply(true, () => live);
    await settle();
    expect(cloud.submitLimit).not.toHaveBeenCalled();
    expect(owner.status().state).toBe('ready');
    owner.stop();
  });
});

async function confirmedHold() {
  const parts = harness();
  const { cloud, owner } = parts;
  await owner.save(SETUP);
  owner.start();
  owner.apply(true, () => true);
  await settle();
  cloud.readLimit.mockResolvedValue(0);
  await poll();
  await poll();
  expect(owner.status().state).toBe('held');
  return parts;
}

const writes = (cloud: ReturnType<typeof harness>['cloud']) => cloud.submitLimit.mock.calls.map(([, amps]) => amps);

async function expectRestored(parts: ReturnType<typeof harness>, enabled = true) {
  parts.cloud.readLimit.mockResolvedValue(60);
  await poll();
  await poll();
  expect(parts.owner.status()).toMatchObject({ state: enabled ? 'ready' : 'disabled', enabled });
}

describe('Deye EV discharge hold release', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restores the saved limit when the EV task ends', async () => {
    const parts = await confirmedHold();
    parts.owner.apply(false, () => false);
    await settle();
    expect(writes(parts.cloud)).toEqual([0, 60]);
    await expectRestored(parts);
    parts.owner.stop();
  });

  it('restores the saved limit and forgets the connection when the owner disables a held limit', async () => {
    const parts = await confirmedHold();
    await expect(parts.owner.disable()).resolves.toMatchObject({ enabled: false });
    await settle();
    expect(writes(parts.cloud)).toEqual([0, 60]);
    await expectRestored(parts, false);
    expect(parts.stored.has(DEYE_DISCHARGE_HOLD_KEY)).toBe(false);
    parts.owner.stop();
  });

  it('retries a restore whose request failed, with a growing delay', async () => {
    const parts = await confirmedHold();
    const { cloud, owner } = parts;
    cloud.submitLimit.mockRejectedValueOnce(new Error('dongle offline'))
      .mockRejectedValueOnce(new Error('dongle offline'))
      .mockRejectedValueOnce(new Error('dongle offline'));
    owner.apply(false, () => false);
    await settle();
    expect(owner.status()).toMatchObject({ state: 'pending', originalLimitA: 60 });
    await poll();
    expect(writes(cloud)).toEqual([0, 60, 60]);
    await poll();
    expect(writes(cloud)).toEqual([0, 60, 60, 60]);
    await poll();
    expect(writes(cloud)).toEqual([0, 60, 60, 60]);
    await poll();
    expect(writes(cloud)).toEqual([0, 60, 60, 60, 60]);
    await expectRestored(parts);
    owner.stop();
  });

  it('releases a held limit from the timer once the meter is stale', async () => {
    const parts = harness();
    const { cloud, owner } = parts;
    let liveMeter = true;
    const lane = bindMainDischargeHold(owner, () => false, () => liveMeter);
    await owner.save(SETUP);
    owner.start();
    lane?.apply(true, () => true);
    await settle();
    cloud.readLimit.mockResolvedValue(0);
    await poll();
    await poll();
    expect(owner.status().state).toBe('held');
    liveMeter = false;
    await poll();
    expect(writes(cloud)).toEqual([0, 60]);
    await expectRestored(parts);
    owner.stop();
  });

  it('writes the saved limit again when Deye reports the restore order failed', async () => {
    const parts = await confirmedHold();
    const { cloud, owner } = parts;
    owner.apply(false, () => false);
    await settle();
    cloud.readOrder.mockResolvedValueOnce('failed');
    await poll();
    await poll();
    expect(writes(cloud)).toEqual([0, 60, 60]);
    await expectRestored(parts);
    owner.stop();
  });

  it('stops waiting for a hold the inverter never applied once its release is owed', async () => {
    const { cloud, owner } = harness();
    await owner.save(SETUP);
    owner.start();
    owner.apply(true, () => true);
    await settle();
    await poll();
    await poll();
    expect(owner.status().state).toBe('pending');
    owner.apply(false, () => false);
    await settle();
    expect(writes(cloud)).toEqual([0]);
    await poll();
    expect(writes(cloud)).toEqual([0, 60]);
    await poll();
    await poll();
    expect(owner.status()).toMatchObject({ state: 'ready', enabled: true });
    owner.stop();
  });

  it('reports an unreadable record as unavailable, not as a recovery', () => {
    const { owner, settings } = harness();
    vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('settings unavailable'); });
    expect(owner.status()).toEqual({ enabled: false, offered: true, state: 'unavailable' });
  });

  it('offers the card only behind the hidden switch until a connection is saved', () => {
    const { owner, stored } = harness();
    expect(owner.status()).toEqual({ enabled: false, offered: false, state: 'disabled' });
    stored.set(DEYE_DISCHARGE_HOLD_OFFERED_KEY, true);
    expect(owner.status()).toEqual({ enabled: false, offered: true, state: 'disabled' });
  });
});
