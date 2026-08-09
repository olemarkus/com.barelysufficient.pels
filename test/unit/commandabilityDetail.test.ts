import { describe, expect, it } from 'vitest';
import {
  DEVICE_UNAVAILABLE_REASON,
  EV_BLOCK_REASONS,
  EV_RESUME_PROBE_FAILED_REASON,
  resolveCommandabilityDetail,
} from '../../packages/shared-domain/src/commandableNowReason';

const EV = { controlCapabilityId: 'evcharger_charging' as const };

describe('resolveCommandabilityDetail — one branch per veto source', () => {
  // The resolver is only called for a device already known to be uncommandable,
  // and its three branches mirror the three inputs that can veto a command. A
  // fourth veto source MUST add a branch here or it renders as the probe copy.
  it('names the plug-state when that is what blocks', () => {
    expect(resolveCommandabilityDetail({ ...EV, evChargingState: 'plugged_out' }))
      .toBe(EV_BLOCK_REASONS.plugged_out);
    expect(resolveCommandabilityDetail({ ...EV, evChargingState: 'plugged_in_discharging' }))
      .toBe(EV_BLOCK_REASONS.plugged_in_discharging);
  });

  it('names unavailability for any device kind', () => {
    expect(resolveCommandabilityDetail({ deviceClass: 'thermostat', available: false }))
      .toBe(DEVICE_UNAVAILABLE_REASON);
    // Plug-state wins over availability for an EV: it is the more specific fact.
    expect(resolveCommandabilityDetail({ ...EV, evChargingState: 'plugged_out', available: false }))
      .toBe(EV_BLOCK_REASONS.plugged_out);
  });

  it('falls through to the resume probe when neither observed fact explains it', () => {
    // A connected, available charger that is nonetheless uncommandable was
    // commanded and never started charging — the executor's backoff.
    expect(resolveCommandabilityDetail({ ...EV, evChargingState: 'plugged_in', available: true }))
      .toBe(EV_RESUME_PROBE_FAILED_REASON);
  });
});
