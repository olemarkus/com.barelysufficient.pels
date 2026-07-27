import {
  PLAN_REASON_CODES,
  formatDeviceReasonUserFacing,
} from '../../shared-domain/src/planReasonSemantics.ts';
import { PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS, PLAN_STATE_LABEL } from '../../shared-domain/src/planStateLabels.ts';
import { resolveIntentStateKind } from '../../shared-domain/src/planCardGrammar.ts';

// The user-visible contract for "Leave off until turned on again", which the
// spec pins deliberately AGAINST the usual pattern: PELS is not holding the
// device back, it is respecting an explicit action, so the card reads `Idle`
// with an explanatory reason rather than `Limited`. See the carve-out in
// notes/ui-terminology.md.

describe('external-off hold — Overview card grammar', () => {
  it('stays Idle rather than being upgraded to Limited', () => {
    const kind = resolveIntentStateKind({
      kind: 'idle',
      reasonCode: PLAN_REASON_CODES.externalOffHold,
      starved: false,
    });
    expect(kind).toBe('idle');
    expect(PLAN_STATE_LABEL[kind]).toBe('Idle');
  });

  it('renders the reason line the spec specifies', () => {
    expect(formatDeviceReasonUserFacing({ code: PLAN_REASON_CODES.externalOffHold }))
      .toBe('Staying off until turned on again');
    expect(PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS).toBe('Staying off until turned on again');
  });

  it('leaks no planner jargon into the user-facing line', () => {
    const line = formatDeviceReasonUserFacing({ code: PLAN_REASON_CODES.externalOffHold });
    for (const jargon of ['shed', 'restore', 'headroom', 'external', 'hold', 'inactive']) {
      expect(line.toLowerCase()).not.toContain(jargon);
    }
  });
});
