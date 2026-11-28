import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeyeDischargeHold } from '../../lib/executor/deyeDischargeHold';
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
    expect(owner.status()).toEqual({ enabled: true, state: 'ready', deviceSn: SETUP.deviceSn, region: 'eu' });
    owner.stop();
  });

  it('keeps an interrupted write across restarts and requires a matching limit and explicit recovery', async () => {
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
    expect(recovered.status()).toEqual({
      enabled: true, state: 'recovery_required', deviceSn: SETUP.deviceSn, originalLimitA: 60, region: 'eu',
    });
    await expect(recovered.save({ ...SETUP, deviceSn: 'different-device' })).rejects.toThrow('same inverter');
    await recovered.save({ ...SETUP, password: 'replacement-password' });
    await expect(recovered.acknowledge({})).rejects.toThrow('Confirm');
    cloud.readLimit.mockResolvedValue(0);
    await expect(recovered.acknowledge({ confirmedOrderSettled: true })).rejects.toThrow('different discharge limit');
    await poll();
    expect(cloud.submitLimit).toHaveBeenCalledTimes(1);
    cloud.readLimit.mockResolvedValue(60);
    await expect(recovered.acknowledge({ confirmedOrderSettled: true })).resolves.toEqual({
      enabled: false, state: 'disabled',
    });
    recovered.stop();
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

  it('does not overwrite a different observed discharge limit when handing back', async () => {
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
    expect(owner.status().state).toBe('ready');
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
