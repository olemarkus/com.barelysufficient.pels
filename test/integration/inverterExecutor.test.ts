import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InverterControlSurface, InverterObservation } from '../../packages/contracts/src/inverterControl';
import { InverterExecutor, type InverterExecutionSource } from '../../lib/executor/inverterExecutor';
import { InverterClaimStore, INVERTER_CLAIM_PREFIX } from '../../lib/executor/inverterClaimStore';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import { partialDouble } from '../helpers/partialDouble';

const NOW = 1_800_000_000_000;
describe('inverter convergence and durable hand-back', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const saved = new Map<string, unknown>();
    const settings: SettingsPort = {
      get: (key) => saved.get(key), getKeys: () => [...saved.keys()],
      set: vi.fn((key, value) => { saved.set(key, value); }), unset: vi.fn((key) => { saved.delete(key); }),
    };
    let observed: InverterObservation = {
      production: { value: 5000, observedAtMs: NOW }, limit: { value: 6000, observedAtMs: NOW },
      mode: { kind: 'direct' },
    };
    const apply = vi.fn<Actuator['apply']>().mockResolvedValue({ requested: true, kind: 'production_limit' });
    const onExternalControl = vi.fn();
    const control = (): InverterControlSurface => observed.mode.kind === 'direct'
      ? { maxW: 6000, stepW: 1, mode: 'direct', authority: 'limit_and_release' }
      : { maxW: 6000, stepW: 1, mode: 'switchable', modeValues: ['device', 'homey', 'eco'],
        authority: 'limit_and_release' };
    const source: InverterExecutionSource = { exists: () => true, control, observation: () => observed,
      simulation: () => false, canLimit: () => true, onExternalControl };
    const store = new InverterClaimStore(settings);
    const actuator = partialDouble<Actuator>({ apply });
    const executor = new InverterExecutor(store, actuator, source);
    executor.ready('pv');
    return { executor, settings, saved, apply, source, store, actuator, onExternalControl, control,
      observed: () => observed, observe: (next: InverterObservation) => { observed = next; } };
  }

  it('records the hand-back target before writing and never turns the request into telemetry', async () => {
    const h = setup();
    h.apply.mockImplementation(async () => {
      expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
      return { requested: true, kind: 'production_limit' };
    });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    expect(h.observed().limit.value).toBe(6000);
    expect(h.executor.ownership('pv')).toMatchObject({ kind: 'held', claim: { previousLimitW: 6000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('drops a new claim when the actuator fence prevents every device write', async () => {
    const h = setup();
    h.apply.mockResolvedValue({ requested: false });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
    expect(h.executor.ownership('pv')).toEqual({ kind: 'free' });
  });

  it('honors an opt-out that arrived after the plan was built', async () => {
    const h = setup();
    h.source.canLimit = () => false;
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it('does not write if the durable hand-back record could not be saved', async () => {
    const h = setup();
    vi.mocked(h.settings.set).mockImplementation(() => { throw new Error('settings unavailable'); });
    expect(await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]))
      .toEqual({ commandRequestCount: 0, failureCount: 1, pendingInverterReleaseCount: 0 });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('keeps and retries a failed write rather than treating it as confirmed', async () => {
    const h = setup();
    h.apply.mockRejectedValueOnce(new Error('timeout'));
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() };
    await h.executor.apply([decision]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
    vi.setSystemTime(NOW + 30_000);
    await h.executor.apply([decision]);
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('restores after restart and retains the record until telemetry confirms the hand-back', async () => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW + 1000 } });
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    restarted.ready('pv');
    expect(restarted.ownership('pv')).toMatchObject({ kind: 'held', recovering: true });
    await restarted.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'production_release',
      target: expect.objectContaining({ limitW: 6000 }) }));
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
    h.observe({ ...h.observed(), limit: { value: 6000, observedAtMs: NOW + 31_000 } });
    vi.setSystemTime(NOW + 31_000);
    await restarted.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it.each(['direct', 'autonomous'] as const)('restores with lagging %s telemetry', async (mode) => {
    const h = setup();
    if (mode === 'autonomous') h.observe({ ...h.observed(),
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'production_release' }));
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
    vi.setSystemTime(NOW + 31_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
    h.observe({ ...h.observed(), limit: { value: 6000, observedAtMs: NOW + 32_000 },
      mode: mode === 'direct' ? { kind: 'direct' }
        : { kind: 'autonomous', value: 'eco', observedAtMs: NOW + 32_000 } });
    vi.setSystemTime(NOW + 62_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it('preserves a different owner mode reported after restart instead of restoring over it', async () => {
    const h = setup();
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW + 1000 } });
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    restarted.ready('pv');
    await restarted.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.onExternalControl).toHaveBeenCalledWith('pv');
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it.each(['direct', 'autonomous'] as const)('accepts a delayed %s report after a retry', async (mode) => {
    const h = setup();
    if (mode === 'autonomous') h.observe({ ...h.observed(),
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW },
      mode: mode === 'direct' ? { kind: 'direct' }
        : { kind: 'controlled', value: 'homey', observedAtMs: NOW } });
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    vi.setSystemTime(NOW + 31_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    h.observe({ ...h.observed(), limit: { value: 6000, observedAtMs: NOW + 1000 },
      mode: mode === 'direct' ? { kind: 'direct' }
        : { kind: 'autonomous', value: 'eco', observedAtMs: NOW + 1000 } });
    vi.setSystemTime(NOW + 62_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it.each(['direct', 'autonomous'] as const)('confirms a changed %s report in the same millisecond', async (mode) => {
    const h = setup();
    if (mode === 'autonomous') h.observe({ ...h.observed(),
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW },
      mode: mode === 'direct' ? { kind: 'direct' }
        : { kind: 'controlled', value: 'homey', observedAtMs: NOW } });
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    h.observe({ ...h.observed(), limit: { value: 6000, observedAtMs: NOW },
      mode: mode === 'direct' ? { kind: 'direct' }
        : { kind: 'autonomous', value: 'eco', observedAtMs: NOW } });
    vi.setSystemTime(NOW + 31_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('accepts a production report between decision and apply while control reports stay unchanged', async () => {
    const h = setup();
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() };
    h.observe({ ...h.observed(), production: { value: 4000, observedAtMs: NOW + 1000 } });
    await h.executor.apply([decision]);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('keeps the opt-in after its own normal hand-back, without mistaking that for manual control', async () => {
    const h = setup();
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW + 1000 },
      mode: { kind: 'controlled', value: 'homey', observedAtMs: NOW + 1000 } });
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    h.observe({ ...h.observed(), limit: { value: 6000, observedAtMs: NOW + 31_000 },
      mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW + 31_000 } });
    vi.setSystemTime(NOW + 31_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.onExternalControl).not.toHaveBeenCalled();
    expect(h.executor.ownership('pv')).toEqual({ kind: 'free' });
  });

  it('takes control from a custom autonomous mode even when its dormant cap already matches', async () => {
    const h = setup();
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW - 1000 },
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() };
    expect(h.executor.hasWork([decision])).toBe(true);
    await h.executor.apply([decision]);
    expect(h.apply).toHaveBeenCalledWith({ kind: 'production_limit', deviceId: 'pv', limitW: 2050 });
    expect(h.executor.ownership('pv')).toMatchObject({ kind: 'held',
      claim: { previousMode: { kind: 'autonomous', value: 'eco' } } });
  });

  it('leaves an explicit later owner mode change alone and disables the opt-in', async () => {
    const h = setup();
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    vi.setSystemTime(NOW + 31_000);
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW + 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    expect(h.onExternalControl).toHaveBeenCalledWith('pv');
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
  it('does not rewrite small feedback changes but follows a meaningful increase', async () => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW + 1000 } });
    vi.setSystemTime(NOW + 31_000);
    const small = { kind: 'limit' as const, deviceId: 'pv', limitW: 2100, binding: h.control(), observation: h.observed() };
    expect(h.executor.hasWork([small])).toBe(false);
    await h.executor.apply([small]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    const meaningful = { ...small, limitW: 2200 };
    expect(h.executor.hasWork([meaningful])).toBe(true);
    await h.executor.apply([meaningful]);
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('still declines a decision after the owner changes the reported cap', async () => {
    const h = setup();
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() };
    h.observe({ ...h.observed(), limit: { value: 2500, observedAtMs: NOW + 1000 } });
    await h.executor.apply([decision]);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it.each([1, 100])('confirms hand-back rounded at native step %i without another write', async (stepW) => {
    const h = setup();
    const control: InverterControlSurface = { maxW: 6000, stepW, mode: 'direct', authority: 'limit_and_release' };
    h.source.control = () => control;
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2000, binding: control, observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2000, observedAtMs: NOW } });
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    h.observe({ ...h.observed(), limit: { value: 6000 - Math.max(1, stepW / 2), observedAtMs: NOW + 1000 } });
    vi.setSystemTime(NOW + 31_000);
    expect(await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]))
      .toEqual({ commandRequestCount: 0, failureCount: 0, pendingInverterReleaseCount: 0 });
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.executor.ownership('pv')).toEqual({ kind: 'free' });
  });

  it('keeps a hand-back pending through retry backoff and a missing observation', async () => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, binding: h.control(), observation: h.observed() }]);
    h.source.observation = () => undefined;
    h.source.control = () => undefined;
    h.apply.mockRejectedValueOnce(new Error('offline'));
    expect(await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]))
      .toEqual({ commandRequestCount: 0, failureCount: 1, pendingInverterReleaseCount: 1 });
    vi.setSystemTime(NOW + 5000);
    expect(await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]))
      .toEqual({ commandRequestCount: 0, failureCount: 0, pendingInverterReleaseCount: 1 });
    vi.setSystemTime(NOW + 31_000);
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'production_release' }));
  });

  it('recovers a legacy claim as saved-limit-only authority', () => {
    const h = setup();
    h.saved.set(`${INVERTER_CLAIM_PREFIX}pv`, {
      previousLimitW: 6000, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000,
    });
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    restarted.ready('pv');
    expect(restarted.ownership('pv')).toMatchObject({ kind: 'held',
      claim: { restoration: { kind: 'limit_only' } } });
  });

  it('declines a limit after its native binding changes while reports stay the same', async () => {
    const h = setup();
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050,
      binding: h.control(), observation: h.observed() };
    h.source.control = () => ({ ...h.control(), maxW: 1000 });
    await h.executor.apply([decision]);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('retains a missing device as pending hand-back without attempting an unreachable write', async () => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050,
      binding: h.control(), observation: h.observed() }]);
    h.source.exists = () => false;
    h.apply.mockClear();
    expect(await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]))
      .toEqual({ commandRequestCount: 0, failureCount: 0, pendingInverterReleaseCount: 1 });
    expect(h.executor.heldDeviceIds()).toEqual(['pv']);
    expect(h.apply).not.toHaveBeenCalled();
    h.source.exists = () => true;
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'production_release' }));
  });

  it('does not confirm an autonomous dormant zero after a binding change', async () => {
    const h = setup();
    h.observe({ ...h.observed(), limit: { value: 0, observedAtMs: NOW },
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050,
      binding: h.control(), observation: h.observed() }]);
    h.source.control = () => ({ ...h.control(), maxW: 5000 });
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW + 1000 },
      mode: { kind: 'controlled', value: 'homey', observedAtMs: NOW + 1000 } });
    await h.executor.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenLastCalledWith({ kind: 'production_release', deviceId: 'pv',
      target: { kind: 'watts_only', limitW: 5000 } });
    h.observe({ ...h.observed(), limit: { value: 0, observedAtMs: NOW + 1000 } });
    vi.setSystemTime(NOW + 31_000);
    expect((await h.executor.apply([{ kind: 'release', deviceId: 'pv' }])).pendingInverterReleaseCount).toBe(1);
    h.observe({ ...h.observed(), limit: { value: 5000, observedAtMs: NOW + 32_000 } });
    vi.setSystemTime(NOW + 62_000);
    expect((await h.executor.apply([{ kind: 'release', deviceId: 'pv' }])).pendingInverterReleaseCount).toBe(0);
    expect(h.executor.ownership('pv')).toEqual({ kind: 'free' });
  });

  it('retains a legacy autonomous claim when no accepted binding proves its ceiling', async () => {
    const h = setup();
    h.saved.set(`${INVERTER_CLAIM_PREFIX}pv`, { previousLimitW: 0,
      previousMode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW - 1000 }, claimedAtMs: NOW });
    h.source.control = () => undefined;
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    restarted.ready('pv');
    expect(await restarted.apply([{ kind: 'release', deviceId: 'pv' }]))
      .toEqual({ commandRequestCount: 0, failureCount: 0, pendingInverterReleaseCount: 1 });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
  });

  it.each(['key list', 'listed claim'] as const)('keeps ownership unresolved across an unreadable %s until it recovers', async (unreadable) => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050,
      binding: h.control(), observation: h.observed() }]);
    const keyRead = vi.spyOn(h.settings, 'getKeys');
    const valueRead = vi.spyOn(h.settings, 'get');
    if (unreadable === 'key list') keyRead.mockImplementation(() => { throw new Error('SDK unavailable'); });
    else valueRead.mockImplementation(() => null);
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    expect(restarted.heldDeviceIds()).toEqual([]);
    expect(restarted.releaseRecoveryReady()).toBe(false);
    keyRead.mockImplementation(() => [...h.saved.keys()]);
    valueRead.mockImplementation((key) => h.saved.get(key));
    expect(restarted.heldDeviceIds()).toEqual(['pv']);
    expect(restarted.releaseRecoveryReady()).toBe(true);
    expect(restarted.ownership('pv')).toMatchObject({ kind: 'held', recovering: true });
  });

});
