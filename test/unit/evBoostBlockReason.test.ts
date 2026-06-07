import { describe, expect, it } from 'vitest';
import {
  EV_BOOST_BLOCK_REASONS,
  resolveEvBoostBlockReason,
} from '../../packages/shared-domain/src/commandableNowReason';

describe('resolveEvBoostBlockReason', () => {
  it('blocks the three plug-states PELS cannot drive toward a charge', () => {
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_out' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_out);
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_discharging' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_in_discharging);
    // `plugged_in` = connected but NOT resumable (distinct from the resumable
    // `plugged_in_paused`): boost can never activate, so it must surface a reason.
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_in);
    expect(EV_BOOST_BLOCK_REASONS.plugged_in).toBe('Car charging won’t resume. Boost will not activate.');
  });

  it('does not block the resumable / charging states (fall through to SoC checks)', () => {
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_paused' })).toBeNull();
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_charging' })).toBeNull();
    expect(resolveEvBoostBlockReason({ evChargingState: undefined })).toBeNull();
  });
});
