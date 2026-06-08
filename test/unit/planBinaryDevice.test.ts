import { withBinaryDiscriminant } from '../../lib/plan/planTypes';

// `isBinaryPlanDevice` keys on the same `controlCapabilityId` discriminant as the
// regrouper; both are exercised end-to-end by the planner integration suites.
// These unit tests pin the novel, behaviour-bearing bit: capability presence is
// the source of truth for binary status, and a transient capability drop revokes
// it (the binary cluster is omitted, not latched).
describe('withBinaryDiscriminant (capability presence = binary status)', () => {
  it('attaches the binary cluster when the control capability is present', () => {
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: 'onoff', binaryControl: { on: true } });
    expect('binaryControl' in out && out.binaryControl).toEqual({ on: true });
  });

  it('omits (and strips a stale) binary cluster when the capability is absent — drop revokes status', () => {
    // The loose bag still carries a latched `binaryControl`, but no capability
    // this cycle: the device is no longer binary, so the cluster must not survive.
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: undefined, binaryControl: { on: true } });
    expect('binaryControl' in out).toBe(false);
  });

  it('defaults to off when the capability is present but binaryControl is missing (mirrors transport ?? false)', () => {
    const out = withBinaryDiscriminant({ id: 'a', controlCapabilityId: 'onoff' });
    expect('binaryControl' in out && out.binaryControl).toEqual({ on: false });
  });
});
