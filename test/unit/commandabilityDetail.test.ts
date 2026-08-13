import { describe, expect, it } from 'vitest';
import {
  BINARY_COMMAND_RETRY_REASON,
  DEVICE_UNAVAILABLE_REASON,
  EV_BLOCK_REASONS,
  resolveCommandabilityDetail,
} from '../../packages/shared-domain/src/commandableNowReason';

describe('resolveCommandabilityDetail — one branch per veto source', () => {
  // The resolver is only called for a device already known to be uncommandable,
  // and its three branches mirror the three inputs that can veto a command. A
  // fourth veto source MUST add a branch here or it renders as the probe copy.
  it('names the plug-state when that is what blocks', () => {
    expect(resolveCommandabilityDetail({ commandabilityReason: 'charger_unplugged' }))
      .toBe(EV_BLOCK_REASONS.plugged_out);
    expect(resolveCommandabilityDetail({ commandabilityReason: 'charger_discharging' }))
      .toBe(EV_BLOCK_REASONS.plugged_in_discharging);
  });

  it('names unavailability for any device kind', () => {
    expect(resolveCommandabilityDetail({ commandabilityReason: 'device_unavailable' }))
      .toBe(DEVICE_UNAVAILABLE_REASON);
    // Plug-state wins over availability for an EV: it is the more specific fact.
    expect(resolveCommandabilityDetail({ commandabilityReason: 'charger_unplugged' }))
      .toBe(EV_BLOCK_REASONS.plugged_out);
  });

  it('names a binary command retry without claiming the device is unavailable', () => {
    expect(resolveCommandabilityDetail({ commandabilityReason: 'binary_command_retry' }))
      .toBe(BINARY_COMMAND_RETRY_REASON);
  });

  it('falls back to generic unavailability when the reason is absent', () => {
    expect(resolveCommandabilityDetail({})).toBe(DEVICE_UNAVAILABLE_REASON);
  });
});
