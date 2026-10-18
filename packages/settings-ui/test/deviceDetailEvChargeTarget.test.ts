// "Charge to a battery level" on a charger's page: the status line states what
// the target means for the car on the cable, from the level the page has, and
// the "before the level is known" hint says what happens to a car that never
// reports one.

import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import { createHomeyMock } from './helpers/homeyApiMock.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUiApi';
import type { EvChargingState } from '../../contracts/src/types';

const IDS = [
  ['div', 'device-detail-charge-target'],
  ['md-switch', 'device-detail-charge-target-enabled'],
  ['md-filled-text-field', 'device-detail-charge-target-percent'],
  ['p', 'device-detail-charge-target-status'],
  ['md-switch', 'device-detail-charge-target-unknown'],
  ['small', 'device-detail-charge-target-unknown-hint'],
] as const;

const CHARGER_ID = 'charger-1';

const buildCharger = (
  level: NonNullable<SettingsUiDeviceSnapshot['stateOfCharge']>['level'] | null,
  evChargingState: EvChargingState = 'plugged_in_charging',
): SettingsUiDeviceSnapshot & { evChargingState: EvChargingState } => ({ ...withDescriptorIdentity<SettingsUiDeviceSnapshot>({
  available: true,
  id: CHARGER_ID,
  name: 'Charger',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  expectedPowerKw: 7, expectedPowerSource: 'default',
  deviceClass: 'evcharger',
  isEvCharger: true,
  powerCapable: true,
  ...(level ? { stateOfCharge: { level } } as Partial<SettingsUiDeviceSnapshot> : {}),
}), evChargingState });

const load = async () => {
  vi.resetModules();
  document.body.replaceChildren(...IDS.map(([tag, id]) => {
    const el = document.createElement(tag);
    el.id = id;
    return el;
  }));
  const { state } = await import('../src/ui/state.ts');
  state.controllableMap = { [CHARGER_ID]: true };
  state.deviceStartPolicyMap = {};
  state.evCarAssociations = {};
  state.evChargeTargetSettings = { [CHARGER_ID]: { targetPercent: 60, chargeBeforeLevelKnown: true } };
  const module = await import('../src/ui/deviceDetail/evChargeTarget.ts');
  const status = () => document.getElementById('device-detail-charge-target-status')!;
  return { module, state, status };
};

describe('charge target status', () => {
  it('says how far the car has to go below the target and that charging stops at it', async () => {
    const { module, status } = await load();

    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 42, observedAtMs: 0 }));
    expect(status().textContent).toBe('Charges to 60%. Now 42%.');

    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 60, observedAtMs: 0 }));
    expect(status().textContent).toBe('Reached 60%. Charging stops here unless a smart task asks for more.');

  });

  it('says a 100% target leaves charging to the car, and promises no stop at 100%', async () => {
    const { module, state, status } = await load();
    state.evChargeTargetSettings = { [CHARGER_ID]: { targetPercent: 100, chargeBeforeLevelKnown: true } };
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 100, observedAtMs: 0 }));
    expect(status().textContent).toBe('The car charges to its own limit. Lower the level to stop earlier.');
    module.renderEvChargeTargetSettings(buildCharger(null));
    expect(status().textContent).toBe('The car charges to its own limit. Lower the level to stop earlier.');

    // With the no-level toggle off, a 100% target still holds a car without a
    // level, so a known level reads as charging and a missing lever names that.
    state.evChargeTargetSettings = { [CHARGER_ID]: { targetPercent: 100, chargeBeforeLevelKnown: false } };
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 100, observedAtMs: 0 }));
    expect(status().textContent).toBe('The car charges to its own limit. Now 100%.');
    state.controllableMap = {};
    module.renderEvChargeTargetSettings(buildCharger(null));
    expect(status().textContent)
      .toBe('PELS only watches this charger. Turn on Power-limit control to hold a car until its level is known.');
  });

  it('names what an unreported level means, and how to get one when no car is selected', async () => {
    const { module, state, status } = await load();
    const unreported = buildCharger({ kind: 'unavailable', reasonCode: 'not_reported' });

    module.renderEvChargeTargetSettings(unreported);
    expect(status().textContent).toBe(
      'Battery level not reported, so the car charges to its own limit. '
      + 'To stop at 60%, select the car under Car or report the level with a Flow.',
    );

    state.evCarAssociations = { [CHARGER_ID]: { carIds: ['car-1'] } } as typeof state.evCarAssociations;
    module.renderEvChargeTargetSettings(unreported);
    expect(status().textContent).toBe('Battery level not reported, so the car charges to its own limit.');

    state.evChargeTargetSettings = { [CHARGER_ID]: { targetPercent: 60, chargeBeforeLevelKnown: false } };
    module.renderEvChargeTargetSettings(unreported);
    expect(status().textContent).toBe('Battery level not reported. Charging is held until it is.');
  });

  it('says there is no car when none is connected', async () => {
    const { module, status } = await load();
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'unavailable', reasonCode: 'not_connected' }));
    expect(status().textContent).toBe('No car connected.');
  });

  it('says there is no car when the charger is unplugged, whatever level was last read', async () => {
    const { module, status } = await load();
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 70, observedAtMs: 0 }, 'plugged_out'));
    expect(status().textContent).toBe('No car connected.');
  });

  it('says PELS cannot stop a charger it has no power reading from', async () => {
    const { module, status } = await load();
    module.renderEvChargeTargetSettings({ ...buildCharger({ kind: 'known', percent: 70, observedAtMs: 0 }), powerCapable: false });
    expect(status().textContent).toBe('PELS has no power reading from this charger, so it cannot stop it at 60%.');
  });

  it('says PELS only watches a charger it may not command', async () => {
    const { module, state, status } = await load();
    state.controllableMap = {};
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 70, observedAtMs: 0 }));
    expect(status().textContent).toBe(
      'PELS only watches this charger. Turn on Power-limit control to stop it at 60%.',
    );
  });

  it('shows no status and disables the fields while the target is off', async () => {
    const { module, state, status } = await load();
    state.evChargeTargetSettings = {};
    module.renderEvChargeTargetSettings(buildCharger({ kind: 'known', percent: 70, observedAtMs: 0 }));
    expect(status().hidden).toBe(true);
    const percent = document.getElementById('device-detail-charge-target-percent') as HTMLElement & {
      disabled: boolean;
      value: string;
    };
    expect(percent.disabled).toBe(true);
    // Turning it on offers 100%, which is how the charger charged before.
    expect(percent.value).toBe('100');
  });

  it('words the unknown-level hint by the choice, never naming whose car it is', async () => {
    const { module, state } = await load();
    const hint = () => document.getElementById('device-detail-charge-target-unknown-hint')!.textContent;

    module.renderEvChargeTargetSettings(buildCharger(null));
    expect(hint()).toBe("A car that doesn't report its level charges to its own limit.");

    state.evChargeTargetSettings = { [CHARGER_ID]: { targetPercent: 60, chargeBeforeLevelKnown: false } };
    module.renderEvChargeTargetSettings(buildCharger(null));
    expect(hint()).toContain("A car that doesn't report its level won't charge here.");
    expect(hint()).not.toMatch(/guest/i);
  });
});

describe('charge target saves', () => {
  it('keeps the stored target when the field is cleared', async () => {
    const { module, state } = await load();
    const homey = createHomeyMock({ settings: {
      ev_charge_target_settings: { [CHARGER_ID]: { targetPercent: 60, chargeBeforeLevelKnown: true } },
    } });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey);
    const refresh = vi.fn();
    module.initEvChargeTargetHandlers({ getCurrentDetailDeviceId: () => CHARGER_ID, refreshOpenDeviceDetail: refresh });
    const percent = document.getElementById('device-detail-charge-target-percent') as HTMLElement & { value: string };

    percent.value = '';
    percent.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(homey.set).not.toHaveBeenCalled();
    expect(state.evChargeTargetSettings[CHARGER_ID]).toEqual({ targetPercent: 60, chargeBeforeLevelKnown: true });
  });

  it('saves only the field that changed, so a redraw from an earlier save cannot undo a queued edit', async () => {
    const { module, state } = await load();
    const homey = createHomeyMock({ settings: {
      ev_charge_target_settings: { [CHARGER_ID]: { targetPercent: 60, chargeBeforeLevelKnown: true } },
    } });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey);
    module.initEvChargeTargetHandlers({ getCurrentDetailDeviceId: () => CHARGER_ID, refreshOpenDeviceDetail: () => undefined });
    const unknown = document.getElementById('device-detail-charge-target-unknown') as HTMLElement & { selected: boolean };
    const percent = document.getElementById('device-detail-charge-target-percent') as HTMLElement & { value: string };

    unknown.selected = false;
    unknown.dispatchEvent(new Event('change'));
    // A refresh from an earlier save redraws the switch from the old setting
    // before the owner's next edit.
    unknown.selected = true;
    percent.value = '70';
    percent.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(homey.__settingsStore.ev_charge_target_settings).toEqual({
        [CHARGER_ID]: { targetPercent: 70, chargeBeforeLevelKnown: false },
      });
    });
    expect(state.evChargeTargetSettings[CHARGER_ID]).toEqual({ targetPercent: 70, chargeBeforeLevelKnown: false });
  });
});
