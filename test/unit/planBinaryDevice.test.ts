import { withBinaryDiscriminant } from '../../lib/plan/planTypes';

// `isBinaryPlanDevice` keys on the same `controlCapabilityId` discriminant as the
// regrouper; both are exercised end-to-end by the planner integration suites.
// These unit tests pin the novel, behaviour-bearing bits: capability presence is
// the source of truth for binary status (a transient drop revokes it — the cluster
// is omitted, not latched), and the cluster the regrouper emits is `currentOn` (the
// resolved on/off truth) — the raw `binaryControl` is stripped, never emitted onto
// the plan kinds.
describe('withBinaryDiscriminant (capability presence = binary status)', () => {
  it('emits currentOn (and strips binaryControl) when the control capability is present', () => {
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: 'onoff', binaryControl: { on: true } });
    expect('currentOn' in out && out.currentOn).toBe(true);
    expect('binaryControl' in out).toBe(false);
  });

  it('omits the binary cluster when the capability is absent — drop revokes status', () => {
    // The loose bag still carries a latched `binaryControl`, but no capability
    // this cycle: the device is no longer binary, so neither `currentOn` nor the
    // stripped `binaryControl` survives.
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: undefined, binaryControl: { on: true } });
    expect('currentOn' in out).toBe(false);
    expect('binaryControl' in out).toBe(false);
  });

  it('resolves currentOn to off when the capability is present but binaryControl is missing', () => {
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: 'onoff' });
    expect('currentOn' in out && out.currentOn).toBe(false);
    expect('binaryControl' in out).toBe(false);
  });
});
