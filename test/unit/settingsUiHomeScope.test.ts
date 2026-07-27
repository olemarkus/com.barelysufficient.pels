// Unit coverage for the `?homeId=` boundary parser
// (`setup/settingsUiHomeScope.ts`). This is the gate that decides whether an
// untrusted query value is allowed to become a settings key, so the rejection
// set is pinned explicitly rather than left to the endpoint tests.
import { describe, expect, it } from 'vitest';
import { SettingsUiHomeScopeAdapter } from '../../setup/settingsUiHomeScope';

const { parseRequestedScope } = SettingsUiHomeScopeAdapter;

describe('SettingsUiHomeScopeAdapter.parseRequestedScope', () => {
  it('treats an absent homeId as the whole-home read', () => {
    // Every in-process caller (bootstrap composer, refresh endpoints, tests)
    // and every unscoped HTTP read land here. `whole_home` is what keeps the
    // response byte-identical to the pre-multi-home payload.
    expect(parseRequestedScope(undefined)).toEqual({ state: 'whole_home' });
    expect(parseRequestedScope({})).toEqual({ state: 'whole_home' });
    expect(parseRequestedScope({ other: 'x' })).toEqual({ state: 'whole_home' });
  });

  it('resolves a well-formed sub-home id', () => {
    expect(parseRequestedScope({ homeId: 'h_abc123' }))
      .toEqual({ state: 'sub_home', homeId: 'h_abc123' });
  });

  // The four mandatory refusals. `rejected` must be DISTINCT from `whole_home`:
  // a malformed id degrading into the main-home read would silently serve one
  // home's control state under another home's name.
  it.each([
    ['empty string', ''],
    ['the main-home sentinel', 'main'],
    ['a settings-key separator', 'h_a:b'],
    ['a bare separator', ':'],
    ['a prototype-colliding key', '__proto__'],
    ['constructor', 'constructor'],
    ['prototype', 'prototype'],
  ])('rejects %s', (_label, homeId) => {
    expect(parseRequestedScope({ homeId })).toEqual({ state: 'rejected' });
  });

  it('rejects a non-string homeId instead of coercing it', () => {
    // Express hands `req.query` through verbatim: a repeated parameter arrives
    // as an array and a bracketed one (`?homeId[x]=y`) as an object. Neither may
    // be stringified into a key.
    expect(parseRequestedScope({ homeId: ['a', 'b'] })).toEqual({ state: 'rejected' });
    expect(parseRequestedScope({ homeId: { x: 'y' } })).toEqual({ state: 'rejected' });
    expect(parseRequestedScope({ homeId: 7 })).toEqual({ state: 'rejected' });
    expect(parseRequestedScope({ homeId: null })).toEqual({ state: 'rejected' });
  });

  it('treats a non-record query bag as the whole-home read', () => {
    expect(parseRequestedScope(null)).toEqual({ state: 'whole_home' });
    expect(parseRequestedScope('homeId=h_a')).toEqual({ state: 'whole_home' });
    expect(parseRequestedScope([])).toEqual({ state: 'whole_home' });
  });

  it('does not consult the prototype chain for the parameter', () => {
    // `{}.homeId` is undefined, but a prototype-polluted global would make a
    // plain property read return a value the caller never sent.
    const polluted = Object.create({ homeId: 'h_injected' }) as Record<string, unknown>;
    expect(parseRequestedScope(polluted)).toEqual({ state: 'whole_home' });
  });
});
