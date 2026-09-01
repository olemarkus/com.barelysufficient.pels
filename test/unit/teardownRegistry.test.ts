import { describe, expect, it, vi } from 'vitest';
import { TeardownRegistry } from '../../lib/utils/teardownRegistry';

describe('TeardownRegistry', () => {
  it('runs a registered callback exactly once on clear, and forgets it', () => {
    const registry = new TeardownRegistry();
    const stop = vi.fn();
    registry.register('task', stop);
    expect(registry.has('task')).toBe(true);

    registry.clear('task');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.has('task')).toBe(false);

    // A second clear is a no-op rather than a double stop.
    registry.clear('task');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('refuses to register over a held key, and leaves the held callback alone', () => {
    const registry = new TeardownRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register('task', first);

    // Silently replacing is what makes `register(key, thing.start())` look
    // safe: the argument evaluates first, so the predecessor's stop would run
    // AFTER the replacement started — and stop callbacks are usually bound to a
    // shared instance, so that kills the new run. Refusing makes it unwritable.
    expect(() => registry.register('task', second)).toThrow(/already held/);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    registry.clear('task');
    expect(first).toHaveBeenCalledTimes(1);
    registry.register('task', second);
    registry.clear('task');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clearing an unknown key does nothing', () => {
    const registry = new TeardownRegistry();
    expect(() => registry.clear('never-registered')).not.toThrow();
    expect(registry.has('never-registered')).toBe(false);
  });

  it('keeps keys independent', () => {
    const registry = new TeardownRegistry();
    const one = vi.fn();
    const two = vi.fn();
    registry.register('one', one);
    registry.register('two', two);
    registry.clear('one');
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
    expect(registry.has('two')).toBe(true);
  });

  it('forgets a key before running it, so a teardown that re-registers is not dropped by the delete', () => {
    const registry = new TeardownRegistry();
    const restarted = vi.fn();
    registry.register('task', () => { registry.register('task', restarted); });

    registry.clear('task');
    // The re-registration survives, because `clear` deleted the old entry
    // before invoking it rather than after.
    expect(registry.has('task')).toBe(true);
    registry.clear('task');
    expect(restarted).toHaveBeenCalledTimes(1);
  });
});
