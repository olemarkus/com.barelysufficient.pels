import { describe, expect, it } from 'vitest';
import {
  EV_BOOST_BLOCK_REASONS,
  resolveEvBoostBlockReason,
} from '../../packages/shared-domain/src/commandableNowReason';

const EV = { deviceClass: 'evcharger' as const };

describe('resolveEvBoostBlockReason', () => {
  it('blocks the two plug-states PELS cannot drive toward a charge', () => {
    expect(resolveEvBoostBlockReason({ ...EV, evChargingState: 'plugged_out' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_out);
    expect(resolveEvBoostBlockReason({ ...EV, evChargingState: 'plugged_in_discharging' }))
      .toBe(EV_BOOST_BLOCK_REASONS.plugged_in_discharging);
  });

  it('does not block `plugged_in` — boost is just "command it on now"', () => {
    // Boost blocks on exactly what actuation blocks on, off the same
    // classification. `plugged_in` is commandable (Easee reports it while awaiting
    // authentication; Wallbox for its own paused state), so the boost panel must
    // not claim boost won't activate.
    expect(resolveEvBoostBlockReason({ ...EV, evChargingState: 'plugged_in' })).toBeNull();
  });

  it('does not block the resumable / charging states (fall through to SoC checks)', () => {
    expect(resolveEvBoostBlockReason({ ...EV, evChargingState: 'plugged_in_paused' })).toBeNull();
    expect(resolveEvBoostBlockReason({ ...EV, evChargingState: 'plugged_in_charging' })).toBeNull();
  });

  it('is not a plug-state question for a non-EV device', () => {
    expect(resolveEvBoostBlockReason({ deviceClass: 'thermostat' })).toBeNull();
  });
});
