// Pins the contracts mirrors of the home-scoping settings keys to the runtime
// originals. `packages/contracts` cannot be imported by value from the runtime
// (sanitize strips it from the shipped bundle) and the settings UI cannot
// import `lib`, so the two sides carry hand-maintained mirrors with a
// "keep both in sync" comment. This test is the executable half of that
// comment: the settings-UI change router keys its per-home cache sweep off
// the CONTRACTS constants (`SUFFIXED_HOME_PLAN_KEY_PREFIXES` in
// `settingsChangeRouter.ts`), and the runtime writes the suffixed keys from
// the LIB constants — if the mirrors drift, the sweep silently stops firing
// and a selected sub-home renders a pre-commit plan for the rest of the
// WebView session, with no error anywhere.
import { describe, expect, it } from 'vitest';
import * as libKeys from '../../lib/utils/settingsKeys';
import * as contractKeys from '../../packages/contracts/src/settingsKeys';

describe('contracts settings-key mirrors match lib/utils/settingsKeys', () => {
  it('mirrors the home-scoping constants byte for byte', () => {
    expect(contractKeys.MAIN_HOME_ID).toBe(libKeys.MAIN_HOME_ID);
    expect(contractKeys.PELS_STATUS).toBe(libKeys.PELS_STATUS);
    expect(contractKeys.POWER_TRACKER_STATE).toBe(libKeys.POWER_TRACKER_STATE);
    expect(contractKeys.HOMES_CONFIG).toBe(libKeys.HOMES_CONFIG);
  });

  it('mirrors homeScopedSettingsKey behaviour on both sides of the main split', () => {
    for (const baseKey of [libKeys.PELS_STATUS, libKeys.POWER_TRACKER_STATE, libKeys.CAPACITY_LIMIT_KW]) {
      expect(contractKeys.homeScopedSettingsKey(baseKey, contractKeys.MAIN_HOME_ID))
        .toBe(libKeys.homeScopedSettingsKey(baseKey, libKeys.MAIN_HOME_ID));
      expect(contractKeys.homeScopedSettingsKey(baseKey, 'h_area1'))
        .toBe(libKeys.homeScopedSettingsKey(baseKey, 'h_area1'));
    }
  });
});
