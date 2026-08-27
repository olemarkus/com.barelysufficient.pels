// Unit tests for the pure per-home operating-mode resolution
// (`lib/utils/capacityHelpers.ts`): the boundary-validated chain
// per-home value → global default, with a pinned mode constrained to the
// global `mode_device_targets` key set so the planner's `[mode] || {}`
// lookup can never silently resolve a pinned mode to EMPTY targets (the
// stuck-cold regression guard from PR #1886), plus the shared per-mode
// device-priority formula.
import { describe, expect, it } from 'vitest';
import {
  resolveConfiguredDevicePriority,
  resolveHomeOperatingMode,
  resolveModeName,
} from '../../lib/utils/capacityHelpers';

const identityAlias = (name: string): string => name;
const TARGETS = {
  Home: { 'dev-1': 21 },
  Cooler: { 'dev-1': 16 },
};
const TARGET_MODES = new Set(Object.keys(TARGETS));

describe('resolveModeName', () => {
  it('follows a retained rename chain until it reaches a configured mode', () => {
    expect(resolveModeName(
      'Cooler',
      { cooler: 'Chill', chill: 'Cold' },
      new Set(['Home', 'Cold']),
    )).toBe('Cold');
  });

  it('stops at a configured alias target so swapped names keep their identities', () => {
    const aliases = { home: 'Work', away: 'Home' };
    const configuredModes = new Set(['Work', 'Home']);

    expect(resolveModeName('Home', aliases, configuredModes)).toBe('Work');
    expect(resolveModeName('Away', aliases, configuredModes)).toBe('Home');
  });

  it('terminates an alias cycle by retaining the originally requested name', () => {
    expect(resolveModeName(
      'Alpha',
      { alpha: 'Beta', beta: 'Alpha' },
      new Set(['Home']),
    )).toBe('Alpha');
  });
});

describe('resolveHomeOperatingMode', () => {
  it('honors a pinned mode that names a mode-targets record', () => {
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: 'Cooler',
      globalMode: 'Home',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    })).toEqual({ mode: 'Cooler', source: 'per_home', fault: null });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('treats %s as genuine absence: global mode, no fault', (_label, raw) => {
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: raw,
      globalMode: 'Home',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    })).toEqual({ mode: 'Home', source: 'global', fault: null });
  });

  it.each([
    ['a number', 42, 'number'],
    ['a boolean', true, 'boolean'],
    ['an object', { mode: 'Cooler' }, 'object'],
    ['an array', ['Cooler'], 'array'],
  ])('classifies %s as a MALFORMED pin: fail-safe global fallback with a distinct fault, never silent unpin', (_label, raw, valueType) => {
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: raw,
      globalMode: 'Home',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    })).toEqual({
      mode: 'Home',
      source: 'global',
      fault: { reason: 'malformed_pin', valueType },
    });
  });

  it('alias-resolves the pinned value before the key-set check', () => {
    const aliases = { kald: 'Cooler' };
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: '  kald ',
      globalMode: 'Home',
      resolveAlias: (name) => resolveModeName(name, aliases, TARGET_MODES),
      modeDeviceTargets: TARGETS,
    })).toEqual({ mode: 'Cooler', source: 'per_home', fault: null });
  });

  it('honors a persistent pin through a retained multi-rename alias chain', () => {
    const modeDeviceTargets = {
      Home: { 'dev-1': 21 },
      Cold: { 'dev-1': 14 },
    };
    const configuredModes = new Set(Object.keys(modeDeviceTargets));
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: 'Cooler',
      globalMode: 'Home',
      resolveAlias: (name) => resolveModeName(
        name,
        { cooler: 'Chill', chill: 'Cold' },
        configuredModes,
      ),
      modeDeviceTargets,
    })).toEqual({ mode: 'Cold', source: 'per_home', fault: null });
  });

  it('REFUSES a pinned mode with no mode-targets record: global fallback + surfaced fault, never empty targets', () => {
    const resolution = resolveHomeOperatingMode({
      perHomeModeRaw: 'Ghost',
      globalMode: 'Home',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    });
    expect(resolution).toEqual({
      mode: 'Home',
      source: 'global',
      fault: { requestedMode: 'Ghost', reason: 'unconfigured_mode' },
    });
    // Mutation guard for the `|| {}` fallthrough: the effective mode must
    // index a REAL record in the blob — the pinned name must never leak
    // through and collapse the restore anchor to an empty map.
    expect(TARGETS[resolution.mode as keyof typeof TARGETS]).toEqual({ 'dev-1': 21 });
  });

  it('does not fault when the unconfigured pinned mode already names the global mode (main parity)', () => {
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: 'Away',
      globalMode: 'Away',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    })).toEqual({ mode: 'Away', source: 'global', fault: null });
  });

  it('never resolves a pinned mode through the prototype chain', () => {
    for (const hostile of ['__proto__', 'constructor', 'toString']) {
      const resolution = resolveHomeOperatingMode({
        perHomeModeRaw: hostile,
        globalMode: 'Home',
        resolveAlias: identityAlias,
        modeDeviceTargets: TARGETS,
      });
      expect(resolution.mode).toBe('Home');
      expect(resolution.fault).toEqual({ reason: 'unconfigured_mode', requestedMode: hostile });
    }
  });

  it('is exact-key: a case-mismatched pinned mode is refused, not silently matched', () => {
    expect(resolveHomeOperatingMode({
      perHomeModeRaw: 'cooler',
      globalMode: 'Home',
      resolveAlias: identityAlias,
      modeDeviceTargets: TARGETS,
    })).toEqual({
      mode: 'Home',
      source: 'global',
      fault: { requestedMode: 'cooler', reason: 'unconfigured_mode' },
    });
  });
});

describe('resolveConfiguredDevicePriority', () => {
  const priorities = {
    Home: { 'dev-1': 1, 'dev-2': 5 },
    Cooler: { 'dev-1': 7 },
  };

  it('reads the stored rank for the given mode', () => {
    expect(resolveConfiguredDevicePriority(priorities, 'Home', 'dev-1')).toBe(1);
    expect(resolveConfiguredDevicePriority(priorities, 'Cooler', 'dev-1')).toBe(7);
  });

  it('reports an unranked device as absent, not as a low rank', () => {
    // The `?? 100` default this used to carry gave every unranked device the
    // same rank. Ranking is the mode catalog owner's job, over a whole set
    // (`packages/shared-domain/src/modeCatalogResolution.ts`); absence here has
    // to stay distinguishable for it to break the tie deterministically.
    expect(resolveConfiguredDevicePriority(priorities, 'Cooler', 'dev-2')).toBeUndefined();
    expect(resolveConfiguredDevicePriority(priorities, 'Ghost', 'dev-1')).toBeUndefined();
  });

  it("falls into the historical 'Home' bucket for an empty mode (main's formula)", () => {
    expect(resolveConfiguredDevicePriority(priorities, '', 'dev-2')).toBe(5);
  });
});
