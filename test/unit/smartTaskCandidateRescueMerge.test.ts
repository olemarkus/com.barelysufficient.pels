import { describe, expect, it } from 'vitest';
import {
  buildValidSmartTaskCandidate,
  parseSmartTaskCandidateRequest,
} from '../../lib/objectives/deferredObjectives';
import type { SmartTaskCandidateRequest } from '../../packages/contracts/src/smartTaskEdit';
import type {
  DeferredObjectiveRescuePermissions,
} from '../../lib/objectives/deferredObjectives/settings';

// The per-key permission merge is the whole reason the request reads its
// booleans as `boolean | undefined`: ABSENT and `false` mean opposite things, so
// the truth table is worth pinning directly on the pure builder rather than only
// through the API lane that calls it.
//
// Scope is deliberately narrow — the lane-level behaviour (which policy the
// write uses, what the gate drops) is covered in
// `test/integration/settingsUiSmartTaskApi.test.ts` and
// `test/e2e/createDeferredObjectiveApp.test.ts`; this file only asserts the
// merge itself.

const DEADLINE_AT_MS = Date.UTC(2026, 0, 1, 6, 0, 0);

const request = (
  permissions: Partial<Pick<
    SmartTaskCandidateRequest,
    'exemptFromBudget' | 'limitLowerPriorityDevices' | 'pauseLowerPriorityDevices'
  >> = {},
): SmartTaskCandidateRequest => ({
  deviceId: 'heater-1',
  kind: 'temperature',
  target: 65,
  readyByLocalTime: '07:00',
  ...permissions,
});

const rescueOf = (
  permissions: Parameters<typeof request>[0],
  standing?: DeferredObjectiveRescuePermissions,
): DeferredObjectiveRescuePermissions | undefined => {
  const candidate = buildValidSmartTaskCandidate(request(permissions), DEADLINE_AT_MS, standing);
  if (!candidate) throw new Error('expected a valid candidate');
  return candidate.rescue;
};

describe('smart-task candidate rescue merge', () => {
  it('keeps an unmentioned permission at its standing mode', () => {
    expect(rescueOf({}, { exemptFromBudget: 'always', pauseLowerPriorityDevices: 'at_risk' }))
      .toEqual({ exemptFromBudget: 'always', pauseLowerPriorityDevices: 'at_risk' });
  });

  it('mints always for a permission granted from nothing', () => {
    expect(rescueOf({ exemptFromBudget: true })).toEqual({ exemptFromBudget: 'always' });
  });

  it('keeps the EXISTING mode when a standing permission is re-granted', () => {
    // A boolean toggle must never promote a conditional grant: `true` means
    // "still on", not "on unconditionally".
    expect(rescueOf({ exemptFromBudget: true }, { exemptFromBudget: 'at_risk' }))
      .toEqual({ exemptFromBudget: 'at_risk' });
  });

  it('revokes only the permission explicitly set to false', () => {
    expect(rescueOf(
      { pauseLowerPriorityDevices: false },
      { exemptFromBudget: 'always', pauseLowerPriorityDevices: 'always' },
    )).toEqual({ exemptFromBudget: 'always' });
  });

  it('drops the whole rescue when every permission is revoked', () => {
    expect(rescueOf(
      {
        exemptFromBudget: false,
        limitLowerPriorityDevices: false,
        pauseLowerPriorityDevices: false,
      },
      {
        exemptFromBudget: 'always',
        limitLowerPriorityDevices: 'always',
        pauseLowerPriorityDevices: 'always',
      },
    )).toBeUndefined();
  });

  it('carries no rescue for a caller that names nothing and has nothing standing', () => {
    expect(rescueOf({})).toBeUndefined();
  });

  it('builds an identical candidate for the same request and standing set', () => {
    // Preview and persist call this with the same three inputs, so equal output
    // here is what makes "preview ≡ persist" true rather than coincidental.
    const standing: DeferredObjectiveRescuePermissions = { exemptFromBudget: 'always' };
    const body = request({
      exemptFromBudget: true,
      limitLowerPriorityDevices: true,
      pauseLowerPriorityDevices: false,
    });
    expect(buildValidSmartTaskCandidate(body, DEADLINE_AT_MS, standing))
      .toEqual(buildValidSmartTaskCandidate(body, DEADLINE_AT_MS, standing));
  });
});

describe('smart-task permission parsing', () => {
  const body = (permissions: Record<string, unknown>) => ({
    deviceId: 'heater-1',
    kind: 'temperature',
    target: 65,
    readyByLocalTime: '07:00',
    ...permissions,
  });

  it('reads absent and false as different values', () => {
    expect(parseSmartTaskCandidateRequest(body({}))?.exemptFromBudget).toBeUndefined();
    expect(parseSmartTaskCandidateRequest(body({ exemptFromBudget: false }))?.exemptFromBudget)
      .toBe(false);
  });

  it.each([null, 'false', 0, 1, {}])(
    'REJECTS a present-but-malformed permission value (%p) instead of reading it as absent',
    (value) => {
      // Folding junk into "absent" would silently preserve a grant the caller
      // may have meant to drop — the two mean opposite things on this wire.
      expect(parseSmartTaskCandidateRequest(body({ exemptFromBudget: value }))).toBeNull();
    },
  );
});
