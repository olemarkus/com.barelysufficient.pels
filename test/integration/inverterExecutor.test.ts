import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InverterObservation } from '../../packages/contracts/src/inverterControl';
import { InverterExecutor } from '../../lib/executor/inverterExecutor';
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
    const source = { observation: () => observed, simulation: () => false, canLimit: () => true, onExternalControl };
    const store = new InverterClaimStore(settings);
    const actuator = partialDouble<Actuator>({ apply });
    const executor = new InverterExecutor(store, actuator, source);
    executor.ready('pv');
    return { executor, settings, saved, apply, source, store, actuator, onExternalControl,
      observed: () => observed, observe: (next: InverterObservation) => { observed = next; } };
  }

  it('records the hand-back target before writing and never turns the request into telemetry', async () => {
    const h = setup();
    h.apply.mockImplementation(async () => {
      expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
      return { requested: true, kind: 'production_limit' };
    });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    expect(h.observed().limit.value).toBe(6000);
    expect(h.executor.ownership('pv')).toMatchObject({ kind: 'held', claim: { previousLimitW: 6000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('drops a new claim when the actuator fence prevents every device write', async () => {
    const h = setup();
    h.apply.mockResolvedValue({ requested: false });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
    expect(h.executor.ownership('pv')).toEqual({ kind: 'free' });
  });

  it('honors an opt-out that arrived after the plan was built', async () => {
    const h = setup();
    h.source.canLimit = () => false;
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(false);
  });

  it('does not write if the durable hand-back record could not be saved', async () => {
    const h = setup();
    vi.mocked(h.settings.set).mockImplementation(() => { throw new Error('settings unavailable'); });
    expect(await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]))
      .toEqual({ commandRequestCount: 0, failureCount: 1 });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('keeps and retries a failed write rather than treating it as confirmed', async () => {
    const h = setup();
    h.apply.mockRejectedValueOnce(new Error('timeout'));
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, observation: h.observed() };
    await h.executor.apply([decision]);
    expect(h.saved.has(`${INVERTER_CLAIM_PREFIX}pv`)).toBe(true);
    vi.setSystemTime(NOW + 30_000);
    await h.executor.apply([decision]);
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('restores after restart and retains the record until telemetry confirms the hand-back', async () => {
    const h = setup();
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    h.observe({ ...h.observed(), limit: { value: 2050, observedAtMs: NOW + 1000 } });
    const restarted = new InverterExecutor(h.store, h.actuator, h.source);
    restarted.ready('pv');
    expect(restarted.ownership('pv')).toMatchObject({ kind: 'held', recovering: true });
    await restarted.apply([{ kind: 'release', deviceId: 'pv' }]);
    expect(h.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'production_release',
      claim: expect.objectContaining({ previousLimitW: 6000 }) }));
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
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
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
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
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
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
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
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
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

  it('declines a stale decision when production changed during the build', async () => {
    const h = setup();
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, observation: h.observed() };
    h.observe({ ...h.observed(), production: { value: 4000, observedAtMs: NOW + 1000 } });
    await h.executor.apply([decision]);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('keeps the opt-in after its own normal hand-back, without mistaking that for manual control', async () => {
    const h = setup();
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
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
    const decision = { kind: 'limit' as const, deviceId: 'pv', limitW: 2050, observation: h.observed() };
    expect(h.executor.hasWork([decision])).toBe(true);
    await h.executor.apply([decision]);
    expect(h.apply).toHaveBeenCalledWith({ kind: 'production_limit', deviceId: 'pv', limitW: 2050 });
    expect(h.executor.ownership('pv')).toMatchObject({ kind: 'held',
      claim: { previousMode: { kind: 'autonomous', value: 'eco' } } });
  });

  it('leaves an explicit later owner mode change alone and disables the opt-in', async () => {
    const h = setup();
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW - 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    vi.setSystemTime(NOW + 31_000);
    h.observe({ ...h.observed(), mode: { kind: 'autonomous', value: 'device', observedAtMs: NOW + 1000 } });
    await h.executor.apply([{ kind: 'limit', deviceId: 'pv', limitW: 2050, observation: h.observed() }]);
    expect(h.onExternalControl).toHaveBeenCalledWith('pv');
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});
