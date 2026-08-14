import { withBinaryDiscriminant } from '../../lib/plan/planTypes';

// `isBinaryPlanDevice` keys on the same producer-resolved `currentOn` as the
// regrouper; both are exercised end-to-end by the planner integration suites.
// These unit tests pin the novel, behaviour-bearing bits: the RESOLVED
// `currentOn` is the source of truth for binary status (a device without one is
// not binary this cycle — the cluster is omitted, not latched, and not
// re-resolved from raw evidence), and the raw `binaryControl` is stripped,
// never emitted onto the plan kinds.
describe('withBinaryDiscriminant (resolved currentOn = binary status)', () => {
  it('emits the pre-resolved currentOn and strips the raw binaryControl', () => {
    const out = withBinaryDiscriminant({ id: 'a', currentOn: true, binaryControl: { on: true } });
    expect('currentOn' in out && out.currentOn).toBe(true);
    expect('binaryControl' in out).toBe(false);
  });

  it('drops the cluster for a bag carrying only the raw binaryControl — the producer resolves, never the regrouper', () => {
    const out = withBinaryDiscriminant({ id: 'a', binaryControl: { on: true } });
    expect('currentOn' in out).toBe(false);
    expect('binaryControl' in out).toBe(false);
  });

  it('omits the binary cluster when nothing resolved this cycle', () => {
    // Neither a resolved `currentOn` nor raw evidence: the device is not binary
    // this cycle, so neither field survives.
    const out = withBinaryDiscriminant({ id: 'a' });
    expect('currentOn' in out).toBe(false);
    expect('binaryControl' in out).toBe(false);
  });

  it('keeps an explicit resolved false — absence and off are different answers', () => {
    const out = withBinaryDiscriminant({ id: 'a', currentOn: false });
    expect('currentOn' in out && out.currentOn).toBe(false);
    expect('binaryControl' in out).toBe(false);
  });
});
