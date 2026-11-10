import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { SHED_RELIEF_AUDIT_HORIZON_MS, ShedReliefAudit } from '../../lib/plan/shedding/shedReliefAudit';
import type { ShedLatchDecision, ShedPlanLatch } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

let capture: LoggerCapture;
beforeEach(() => { capture = captureLogger('info', []); });
afterEach(() => { capture.restore(); });

const T0 = 1_800_000_000_000;
const NO_RESTORES: ReadonlySet<string> = new Set();

const device = (id: string, drawKw?: number): PlanInputDevice => ({
  id, name: `Heater ${id}`, ...(drawKw === undefined ? {} : { currentDrawKw: drawKw }),
}) as unknown as PlanInputDevice;

const latch = (entries: Record<string, ShedLatchDecision[]>): ShedPlanLatch => ({
  powerW: 0, decisions: new Map(Object.entries(entries)), stepTargets: new Map(),
});

const decision = (decidedAtMs: number, creditedKw = 1): ShedLatchDecision => ({
  kind: 'demand', creditedKw, decidedAtMs,
});

describe('ShedReliefAudit', () => {
  it('reports a lone shed once, a horizon later, with the meter and device falls', () => {
    const audit = new ShedReliefAudit();
    const shed = latch({ a: [decision(T0)] });
    audit.observe(shed, [device('a', 1)], 6.2, NO_RESTORES, T0);
    audit.observe(shed, [device('a', 0.4)], 5.6, NO_RESTORES, T0 + 20_000);
    expect(capture.findEvents('shed_relief_observed')).toHaveLength(0);
    audit.observe(null, [device('a', 0)], 5.15, NO_RESTORES, T0 + SHED_RELIEF_AUDIT_HORIZON_MS + 2_000);
    audit.observe(null, [device('a', 0)], 5, NO_RESTORES, T0 + 90_000);
    expect(capture.findEvents('shed_relief_observed')).toEqual([expect.objectContaining({
      deviceId: 'a', deviceName: 'Heater a', reliefKind: 'demand', creditedKw: 1,
      wholeHomeBeforeKw: 6.2, wholeHomeAfterKw: 5.15, observedFallKw: 1.05,
      deviceDrawBeforeKw: 1, deviceDrawAfterKw: 0, elapsedMs: SHED_RELIEF_AUDIT_HORIZON_MS + 2_000,
      soleDecision: true,
    })]);
  });

  it('marks sheds that overlap another shed or a restore as not sole', () => {
    const audit = new ShedReliefAudit();
    audit.observe(latch({ a: [decision(T0)] }), [device('a', 1), device('b', 2)], 6, NO_RESTORES, T0);
    audit.observe(
      latch({ a: [decision(T0)], b: [decision(T0 + 10_000, 2)] }), [device('a', 0), device('b', 2)],
      5.5, NO_RESTORES, T0 + 10_000,
    );
    const restored = new ShedReliefAudit();
    restored.observe(latch({ c: [decision(T0)] }), [device('c', 1)], 6, NO_RESTORES, T0);
    restored.observe(null, [device('c', 0)], 6, new Set(['d']), T0 + 5_000);
    for (const each of [audit, restored]) {
      each.observe(null, [], 4, NO_RESTORES, T0 + 120_000);
    }
    const lines = capture.findEvents('shed_relief_observed');
    expect(lines.map((line) => [line.deviceId, line.soleDecision])).toEqual([['a', false], ['b', false], ['c', false]]);
    expect(lines.find((line) => line.deviceId === 'c')).not.toHaveProperty('deviceDrawAfterKw');
  });

  it('keeps one line for relief added to a decision on its own stamp, at the larger credit', () => {
    const audit = new ShedReliefAudit();
    audit.observe(latch({ a: [decision(T0, 1)] }), [device('a', 3)], 7, NO_RESTORES, T0);
    audit.observe(latch({ a: [decision(T0, 2.5)] }), [device('a', 3)], 7, NO_RESTORES, T0 + 5_000);
    audit.observe(null, [device('a', 0.5)], 4.5, NO_RESTORES, T0 + 61_000);
    expect(capture.findEvents('shed_relief_observed')).toEqual([
      expect.objectContaining({ deviceId: 'a', creditedKw: 2.5, observedFallKw: 2.5, soleDecision: true }),
    ]);
  });

  it('ignores decisions it did not see taken and withdrawn demand', () => {
    const audit = new ShedReliefAudit();
    audit.observe(
      latch({ a: [decision(T0 - 5_000)], b: [{ ...decision(T0), kind: 'withdrawn_demand' }] }),
      [device('a', 1), device('b', 1)], 6, NO_RESTORES, T0,
    );
    audit.observe(null, [], 5, NO_RESTORES, T0 + 120_000);
    expect(capture.findEvents('shed_relief_observed')).toHaveLength(0);
  });
});
