import {
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
  normalizeDeferredObjectiveActivePlansShape,
} from '../../packages/shared-domain/src/deferredObjectiveActivePlanShape';

// Direct coverage of the shared envelope guard both surfaces delegate to. The two
// call sites (runtime deep-validator + UI narrow view) are each covered by their
// own suites; these pin the generic itself — the single `empty()` exit for every
// reject branch and the per-surface `TEmpty` fallback (envelope vs null) — so a
// future edit to the generic can't regress one surface without tripping a test.

// A "plan" is any object carrying a numeric `marker`, for the test predicate.
type TestPlan = { marker: number };
const isTestPlan = (plan: unknown): plan is TestPlan => (
  typeof plan === 'object' && plan !== null && typeof (plan as { marker?: unknown }).marker === 'number'
);

const EMPTY_ENVELOPE = { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plansByDeviceId: {} } as const;
const runtimeLike = { isValidPlan: isTestPlan, empty: () => EMPTY_ENVELOPE };
const uiLike = { isValidPlan: isTestPlan, empty: () => null };

describe('normalizeDeferredObjectiveActivePlansShape', () => {
  describe.each([
    ['null', null],
    ['undefined', undefined],
    ['a primitive', 7],
    ['an array', []],
    ['a wrong-version blob', { version: 2, plansByDeviceId: { a: { marker: 1 } } }],
    ['a missing plansByDeviceId', { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION }],
    ['a non-object plansByDeviceId', { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plansByDeviceId: 9 }],
    // `typeof [] === 'object'` — an array plansByDeviceId must reject, not
    // `Object.entries` into numeric-key pseudo-deviceIds.
    ['an array plansByDeviceId', { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plansByDeviceId: [{ marker: 1 }] }],
  ])('reject branch: %s', (_label, raw) => {
    it('returns the runtime empty envelope', () => {
      expect(normalizeDeferredObjectiveActivePlansShape(raw, runtimeLike)).toBe(EMPTY_ENVELOPE);
    });
    it('returns the UI null fallback', () => {
      expect(normalizeDeferredObjectiveActivePlansShape(raw, uiLike)).toBeNull();
    });
  });

  it('keeps valid per-device entries and drops invalid ones', () => {
    const raw = {
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { keep: { marker: 1 }, dropObj: { nope: true }, dropPrim: 5 },
    };
    const result = normalizeDeferredObjectiveActivePlansShape(raw, runtimeLike);
    expect(result).toEqual({
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { keep: { marker: 1 } },
    });
  });

  it('returns a fresh envelope (does not alias the persisted blob)', () => {
    const inner = { marker: 1 };
    const raw = { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plansByDeviceId: { keep: inner } };
    const result = normalizeDeferredObjectiveActivePlansShape(raw, runtimeLike);
    expect(result).not.toBe(raw);
    if (result === EMPTY_ENVELOPE) throw new Error('expected a populated envelope');
    expect(result.plansByDeviceId).not.toBe(raw.plansByDeviceId);
  });
});
