import {
  PLAN_REASON_CODES,
  formatDeviceReasonUserFacing,
} from '../../shared-domain/src/planReasonSemantics.ts';
import { PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS } from '../../shared-domain/src/planStateLabels.ts';
import {
  displayStateLabel,
  resolveDisplayStateKind,
  resolveIntentStateKind,
} from '../../shared-domain/src/planCardGrammar.ts';

// The user-visible contract for "Leave off until turned on again", which the
// spec pins deliberately AGAINST the usual pattern: PELS is not limiting the
// device, it is respecting an explicit action, so the card reads `Off` with an
// explanatory reason rather than `Limited`. See the carve-out in
// notes/ui-terminology.md.

describe('external-off hold — Overview card grammar', () => {
  it('stays outside Limited intent and displays the observed Off fact', () => {
    const intentKind = resolveIntentStateKind({
      kind: 'idle',
      reasonCode: PLAN_REASON_CODES.externalOffHold,
      starved: false,
    });
    expect(intentKind).toBe('idle');
    const displayKind = resolveDisplayStateKind({
      kind: intentKind,
      reasonCode: PLAN_REASON_CODES.externalOffHold,
      starved: false,
      dryRun: false,
      currentState: 'off',
    });
    expect(displayKind).toBe('off');
    expect(displayStateLabel(displayKind)).toBe('Off');
  });

  it('renders the reason line the spec specifies', () => {
    expect(formatDeviceReasonUserFacing({ code: PLAN_REASON_CODES.externalOffHold }))
      .toBe('Turned off elsewhere — turn it on to resume');
    expect(PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS)
      .toBe('Turned off elsewhere — turn it on to resume');
  });

  it('leaks no planner jargon into the user-facing line', () => {
    const line = formatDeviceReasonUserFacing({ code: PLAN_REASON_CODES.externalOffHold });
    for (const jargon of ['shed', 'restore', 'headroom', 'external', 'hold', 'inactive']) {
      expect(line.toLowerCase()).not.toContain(jargon);
    }
  });
});
