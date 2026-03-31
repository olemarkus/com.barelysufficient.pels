/**
 * @jest-environment node
 */
import { getCurrentContext, runWithContext } from '../../lib/logging/alsContext';

function nestedContext(): Record<string, unknown> {
  return runWithContext({ correlationId: 'abc', component: 'plan' }, () => (
    runWithContext({ rebuildId: 'rb1' }, () => getCurrentContext())
  ));
}

function conflictingContext(): { inner: Record<string, unknown>; outer: Record<string, unknown> } {
  return runWithContext({ mode: 'old' }, () => {
    const inner = runWithContext({ mode: 'new' }, () => getCurrentContext());
    const outer = getCurrentContext();
    return { inner, outer };
  });
}

describe('alsContext', () => {
  it('returns empty object when no context is set', () => {
    expect(getCurrentContext()).toEqual({});
  });

  it('provides context inside runWithContext', () => {
    runWithContext({ correlationId: 'abc' }, () => {
      expect(getCurrentContext()).toEqual({ correlationId: 'abc' });
    });
  });

  it('merges parent context with child context', () => {
    const result = nestedContext();
    expect(result).toEqual({
      correlationId: 'abc',
      component: 'plan',
      rebuildId: 'rb1',
    });
  });

  it('inner scope wins on conflicts', () => {
    const { inner, outer } = conflictingContext();
    expect(inner).toEqual({ mode: 'new' });
    expect(outer).toEqual({ mode: 'old' });
  });

  it('context survives across await', async () => {
    await runWithContext({ asyncId: '123' }, async () => {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      expect(getCurrentContext()).toEqual({ asyncId: '123' });
    });
  });

  it('sibling async flows do not leak context', async () => {
    const results: Record<string, unknown>[] = [];

    await Promise.all([
      runWithContext({ flowId: 'A' }, async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        results.push(getCurrentContext());
      }),
      runWithContext({ flowId: 'B' }, async () => {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        results.push(getCurrentContext());
      }),
    ]);

    expect(results).toContainEqual({ flowId: 'A' });
    expect(results).toContainEqual({ flowId: 'B' });
  });

  it('context is clean after runWithContext returns', () => {
    runWithContext({ temp: true }, () => {
      // inside scope
    });
    expect(getCurrentContext()).toEqual({});
  });
});
