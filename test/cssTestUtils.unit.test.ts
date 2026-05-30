import { describe, expect, test } from 'vitest';

import { isUnguardedDisplayRule } from './cssTestUtils';

// Direct coverage for the `[hidden]`-guard detector. The shared suite only runs
// it on the belt-and-suspenders path (when a stylesheet has NO blanket reset),
// which today's widgets never hit, so the detector's selector-grouping logic is
// otherwise unexercised.
describe('isUnguardedDisplayRule', () => {
  const toggled = ['.list-view', '.detail-view'] as const;

  test('flags a display rule on a hidden-toggled selector with no self-guard', () => {
    expect(isUnguardedDisplayRule({ selectors: '.list-view', body: 'display:flex' }, toggled)).toBe(true);
  });

  test('passes a self-guarded display rule', () => {
    expect(isUnguardedDisplayRule({ selectors: '.list-view:not([hidden])', body: 'display:flex' }, toggled)).toBe(false);
  });

  test('passes a rule that does not set display', () => {
    expect(isUnguardedDisplayRule({ selectors: '.list-view', body: 'color:red' }, toggled)).toBe(false);
  });

  test('flags an unguarded member inside a comma group where a sibling IS guarded', () => {
    // The `.includes()` predicate this replaced returned a false negative here:
    // the guarded `.list-view:not([hidden])` substring masked the unguarded
    // `.detail-view`.
    expect(
      isUnguardedDisplayRule({ selectors: '.list-view:not([hidden]), .detail-view', body: 'display:flex' }, toggled),
    ).toBe(true);
  });

  test('passes a comma group where every member is self-guarded', () => {
    expect(
      isUnguardedDisplayRule(
        { selectors: '.list-view:not([hidden]), .detail-view:not([hidden])', body: 'display:flex' },
        toggled,
      ),
    ).toBe(false);
  });
});
