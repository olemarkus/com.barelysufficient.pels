// Companion to deviceCapacityControlObserveOnlyFilter (FIX 2): the BUDGET-EXEMPTION
// action cards and the device-snapshot CONDITION cards must also keep auto-tracked
// OBSERVE-ONLY devices (home battery / solar, deviceClass 'battery'/'solarpanel') out of
// their device pickers — finishing the "hide observe-only fully" contract. The condition
// RUN listener still answers truthfully for whatever device a pre-existing flow references
// (an observe-only battery genuinely IS `managed` internally), so the filter is on the
// autocomplete only, never a silent break of an existing flow.
//
// Drives the REAL flow-card registrars against the shared mock flow seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance } from '../mocks/homey';
import {
  registerBudgetExemptionCondition,
  registerBudgetExemptionCards,
  registerManagedDeviceCondition,
} from '../../flowCards/deviceSettingsCards';
import { BUDGET_EXEMPT_DEVICES } from '../../lib/utils/settingsKeys';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';

const HEATER_ID = 'heater';
const BATTERY_ID = 'home-battery';
const SOLAR_ID = 'solar';

const snapshot = [
  { id: HEATER_ID, name: 'Heater', targets: [], deviceClass: 'heater', managed: true, controllable: true, budgetExempt: false },
  { id: BATTERY_ID, name: 'Home Battery', targets: [], deviceClass: 'battery', managed: true, controllable: false, budgetExempt: false },
  { id: SOLAR_ID, name: 'Solar Panel', targets: [], deviceClass: 'solarpanel', managed: true, controllable: false, budgetExempt: false },
] as unknown as DecoratedDeviceSnapshot[];

const infoSpy = vi.fn();

const buildDeps = (): FlowCardDeps => ({
  homey: mockHomeyInstance as unknown as FlowCardDeps['homey'],
  getSnapshot: async () => snapshot,
  getStructuredLogger: () => ({ info: infoSpy } as unknown as ReturnType<FlowCardDeps['getStructuredLogger']>),
} as unknown as FlowCardDeps);

beforeEach(() => {
  mockHomeyInstance.settings.clear();
  mockHomeyInstance.flow._actionCardListeners = {};
  mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
  mockHomeyInstance.flow._conditionCardListeners = {};
  mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
  infoSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('budget-exemption cards exclude observe-only devices', () => {
  beforeEach(() => {
    registerBudgetExemptionCards(buildDeps());
  });

  it('autocomplete offers the heater but NOT the observe-only battery/solar', async () => {
    const listener = mockHomeyInstance.flow._actionCardAutocompleteListeners.add_budget_exemption.device;
    const ids = ((await listener('')) as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(HEATER_ID);
    expect(ids).not.toContain(BATTERY_ID);
    expect(ids).not.toContain(SOLAR_ID);
  });

  it('a write hand-driven with the battery id is a no-op (no budget_exempt_devices row written)', async () => {
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const runListener = mockHomeyInstance.flow._actionCardListeners.add_budget_exemption;
    await runListener({ device: { id: BATTERY_ID } });
    expect(setSpy).not.toHaveBeenCalledWith(BUDGET_EXEMPT_DEVICES, expect.anything());
    expect(mockHomeyInstance.settings.get(BUDGET_EXEMPT_DEVICES)).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_setting_toggle_skipped',
      deviceId: BATTERY_ID,
    }));
  });

  it('a write for the heater still persists the budget_exempt_devices row', async () => {
    const runListener = mockHomeyInstance.flow._actionCardListeners.add_budget_exemption;
    await runListener({ device: { id: HEATER_ID } });
    expect(mockHomeyInstance.settings.get(BUDGET_EXEMPT_DEVICES)).toEqual({ [HEATER_ID]: true });
  });
});

describe('device-snapshot condition cards exclude observe-only devices from the picker', () => {
  beforeEach(() => {
    registerManagedDeviceCondition(buildDeps());
    registerBudgetExemptionCondition(buildDeps());
  });

  it('is_device_managed autocomplete offers the heater but NOT the observe-only battery/solar', async () => {
    const listener = mockHomeyInstance.flow._conditionCardAutocompleteListeners.is_device_managed.device;
    const ids = ((await listener('')) as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(HEATER_ID);
    expect(ids).not.toContain(BATTERY_ID);
    expect(ids).not.toContain(SOLAR_ID);
  });

  it('is_device_managed run listener still answers truthfully for an already-referenced battery (managed internally)', async () => {
    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    // A flow built before the autocomplete filter that already points at the battery keeps
    // evaluating correctly — the battery genuinely IS managed; we never silently flip it false.
    await expect(runCondition({ device: { id: BATTERY_ID } })).resolves.toBe(true);
  });
});
