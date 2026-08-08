import { describe, expect, it } from 'vitest';
import {
  EV_BOOST_BLOCK_REASONS,
  resolveEvBoostBlockReason,
} from '../../packages/shared-domain/src/commandableNowReason';

describe('resolveEvBoostBlockReason', () => {
  it('blocks the two plug-states PELS cannot drive toward a charge', () => {
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_out' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_out);
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_discharging' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_in_discharging);
  });

  it('blocks boost when the charger state is unavailable', () => {
    expect(resolveEvBoostBlockReason({}))
      .toBe(EV_BOOST_BLOCK_REASONS.state_unknown);
  });

  it('does not block `plugged_in` — boost is just "command it on now"', () => {
    // Boost blocks on exactly what actuation blocks on, off the same
    // `resolveEvBlockReasonKey` classification. `plugged_in` is commandable
    // (Easee reports it while awaiting authentication; Wallbox reports it for its
    // own paused state), so the boost panel must not claim boost won't activate.
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in' })).toBeNull();
  });

  it('does not block the resumable / charging states (fall through to SoC checks)', () => {
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_paused' })).toBeNull();
    expect(resolveEvBoostBlockReason({ evChargingState: 'plugged_in_charging' })).toBeNull();
  });
});
