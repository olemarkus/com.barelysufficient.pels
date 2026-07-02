import {
  deviceDetailDumpLoadDisabledHint,
  deviceDetailDumpLoadOpt,
  deviceDetailDumpLoadPowerLimitHint,
  deviceDetailDumpLoadRow,
  deviceDetailSurplusDelta,
  deviceDetailSurplusOpt,
  deviceDetailSurplusSection,
} from '../dom.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { isEvDevice } from '../../../../shared-domain/src/commandableNow.ts';
import { logSettingsError } from '../logging.ts';
import { savePriceOptimizationSettings } from '../priceOptimization.ts';
import {
  resolveHomeExhibitsSolar,
  resolveManagedState,
  state,
  defaultPriceOptimizationConfig,
  type PriceOptimizationConfig,
} from '../state.ts';
import { showToastError } from '../toast.ts';
import { resolveDeviceDetailControlMode } from './controlMode.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const parseSurplusDeltaInput = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value || '');
  // Raise-only and bounded; a non-finite, negative, or wild value snaps to the default.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 20) return fallback;
  return parsed;
};

const readSurplusInputs = (): { surplusWilling: boolean; surplusDelta: number } => ({
  surplusWilling: deviceDetailSurplusOpt?.selected || false,
  surplusDelta: parseSurplusDeltaInput(deviceDetailSurplusDelta?.value, 2),
});

export const setDeviceDetailSurplusValues = (deviceId: string) => {
  const config = state.priceOptimizationSettings[deviceId];
  if (deviceDetailSurplusDelta) {
    deviceDetailSurplusDelta.value = (config?.surplusDelta ?? 2).toString();
  }
};

export const updateSurplusSectionVisibility = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  if (!deviceDetailSurplusSection || !deviceDetailSurplusOpt) return;
  const device = params.currentDetailDeviceId ? params.getDeviceById(params.currentDetailDeviceId) : null;
  const isManaged = params.currentDetailDeviceId ? resolveManagedState(params.currentDetailDeviceId) : false;
  // Field-only section, shown only when the "Use solar surplus" toggle (in the
  // Control section) is on — mirrors how "Price response" gates on its switch.
  // Solar-only: gated on the home exhibiting solar (a tracked solar/PV device OR
  // material grid export from a meter-only PV inverter), so it never appears in a
  // home that does not export; and only on a managed temperature device (the only
  // kind that self-consumes by raising a setpoint).
  deviceDetailSurplusSection.style.display
    = resolveHomeExhibitsSolar() && supportsTemperatureDevice(device) && isManaged && deviceDetailSurplusOpt.selected
      ? 'block' : 'none';
};

export const initDeviceDetailSurplusOptHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  const autoSaveSurplus = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const device = params.getDeviceById(deviceId);
    if (!supportsTemperatureDevice(device)) return;

    const { surplusWilling, surplusDelta } = readSurplusInputs();
    // Snapshot only this device's surplus fields before the optimistic mutation so
    // a failed Homey write can be rolled back without clobbering newer edits.
    const config = ensurePriceOptimizationConfig(deviceId);
    const previousValues = { surplusWilling: config.surplusWilling, surplusDelta: config.surplusDelta };
    config.surplusWilling = surplusWilling;
    config.surplusDelta = surplusDelta;

    try {
      await savePriceOptimizationSettings();
      // Only re-bind if the user is still on this device's panel — a late save for
      // device A must not rewrite device B's open panel (mirrors priceOpt). Re-binds
      // the delta input to the saved (snapped) value so an out-of-range entry doesn't
      // leave the field showing a number we didn't persist, and re-evaluates the
      // section's visibility against the current switch state.
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusValues(deviceId);
        updateSurplusSectionVisibility({ currentDetailDeviceId: deviceId, getDeviceById: params.getDeviceById });
      }
    } catch (error) {
      const current = state.priceOptimizationSettings[deviceId];
      if (current
        && current.surplusWilling === surplusWilling
        && current.surplusDelta === surplusDelta) {
        Object.assign(current, previousValues);
      }
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusValues(deviceId);
        const restored = state.priceOptimizationSettings[deviceId];
        if (deviceDetailSurplusOpt) deviceDetailSurplusOpt.selected = restored?.surplusWilling ?? false;
      }
      await logSettingsError('Failed to save solar surplus settings', error, 'device detail');
      await showToastError(error, 'Failed to save solar surplus settings.');
    }
  };

  deviceDetailSurplusOpt?.addEventListener('change', autoSaveSurplus);
  deviceDetailSurplusDelta?.addEventListener('change', autoSaveSurplus);
  initDeviceDetailDumpLoadHandlers(params);
};

// ─── "Run on solar surplus" — binary dump-load posture ────────────────────────
//
// The SAME `surplusWilling` opt-in, disambiguated by modality: on a plain binary
// (on/off) device it means "PELS keeps this device off and turns it on while the
// home exports enough solar to cover it" (`surplusDelta` is ignored). Gate
// mirrors the runtime candidacy (`resolveSurplusOnlyPosture`): managed +
// power-limit-controllable binary device, not temperature, not stepped, not EV —
// and, unlike the temperature sections above, ALSO `canManageDevice` from day
// one (TODO.md "Gate the device-detail Price-response + Solar-surplus sections
// on canManageDevice": fixed here for the new section; the pre-existing
// temperature gating is deliberately left unchanged in this PR).

const hasActiveSmartTask = (deviceId: string): boolean => {
  const entry = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
  if (!entry || !entry.enabled) return false;
  return Number.isFinite(entry.deadlineAtMs) && entry.deadlineAtMs > Date.now();
};

// Device-shape candidacy WITHOUT the solar-presence gate: managed,
// power-limit-controllable binary device, not temperature/stepped/EV. Mirrors the
// runtime `resolveSurplusOnlyPosture` (which likewise never checks solar presence —
// solar is a UI-offer concern, not a runtime one).
const isDumpLoadDeviceShape = (
  device: SettingsUiDeviceDetailItem | null,
  controlState: { supportsTemperature: boolean; isManaged: boolean; canManageDevice: boolean },
): boolean => {
  if (!device) return false;
  if (!controlState.canManageDevice || !controlState.isManaged) return false;
  if (controlState.supportsTemperature) return false;
  // Binary modality mirrors the runtime discriminant: capability presence.
  if (device.controlCapabilityId === undefined) return false;
  if (isEvDevice(device)) return false;
  // Stepped / continuous / EV-preset control modes are stepped-load territory —
  // the dump-load posture is for plain on/off loads only.
  if (resolveDeviceDetailControlMode(device) !== 'default') return false;
  return true;
};

// The dump-load posture only takes effect when PELS actually controls the device's
// on/off — runtime `toPlanDevice` gates `surplusOnly` on `isCapacityControlEnabled`
// = managed AND power-limit-controllable. Mirror the controllable half here
// (managed is already in `isDumpLoadDeviceShape`) so the toggle never silently
// does nothing: with Power-limit control off, the saved `surplusWilling` is
// ignored at runtime.
const isPowerLimitControlOn = (deviceId: string): boolean => state.controllableMap[deviceId] === true;

/**
 * Sync the "Run on solar surplus" row for the open device. Shown when the device
 * is a fresh candidate (shape-valid AND the home has solar) OR is ALREADY opted
 * in — so the opt-OUT stays reachable even if the solar device later disappears.
 * The switch reflects the persisted `surplusWilling`, and is disabled — with a
 * visible "why" hint — while EITHER the device's Power-limit control is off (the
 * posture would be inert at runtime; recourse is right above in the same cluster)
 * OR the device has an active smart task (the schedule wins). Byte-identical to
 * the pre-existing behaviour in the enabled case (power-limit on, no smart task).
 */
// Resolve + apply the enabled switch's disabled state and the two "why" hints.
// Power-limit-off is the more fundamental blocker, so its hint wins when both apply.
const applyDumpLoadDisabledState = (deviceId: string): void => {
  const powerLimitOff = !isPowerLimitControlOn(deviceId);
  const disabledBySmartTask = hasActiveSmartTask(deviceId);
  if (deviceDetailDumpLoadOpt) deviceDetailDumpLoadOpt.disabled = powerLimitOff || disabledBySmartTask;
  if (deviceDetailDumpLoadPowerLimitHint) deviceDetailDumpLoadPowerLimitHint.hidden = !powerLimitOff;
  if (deviceDetailDumpLoadDisabledHint) {
    deviceDetailDumpLoadDisabledHint.hidden = !(disabledBySmartTask && !powerLimitOff);
  }
};

const hideDumpLoadRow = (): void => {
  if (deviceDetailDumpLoadOpt) {
    deviceDetailDumpLoadOpt.selected = false;
    deviceDetailDumpLoadOpt.disabled = true;
  }
  if (deviceDetailDumpLoadDisabledHint) deviceDetailDumpLoadDisabledHint.hidden = true;
  if (deviceDetailDumpLoadPowerLimitHint) deviceDetailDumpLoadPowerLimitHint.hidden = true;
};

export const setDeviceDetailDumpLoadControl = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  if (!deviceDetailDumpLoadRow || !deviceDetailDumpLoadOpt) return;
  const device = params.deviceId ? params.getDeviceById(params.deviceId) : null;
  const controlState = resolveDeviceDetailControlState(device, params.deviceId ?? '');
  const shape = params.deviceId !== null && isDumpLoadDeviceShape(device, controlState);
  const optedIn = params.deviceId !== null
    && state.priceOptimizationSettings[params.deviceId]?.surplusWilling === true;
  // Solar-only, matching the temperature surplus/boost gate: the home must
  // exhibit solar — a tracked solar/PV device OR material grid export from a
  // meter-only PV inverter (`resolveHomeExhibitsSolar`). Escape hatch: keep the
  // row visible whenever the device is opted in, regardless of that signal, so
  // the user can always turn it back off.
  const showRow = shape && (resolveHomeExhibitsSolar() || optedIn);
  deviceDetailDumpLoadRow.hidden = !showRow;
  if (!showRow || !params.deviceId) {
    hideDumpLoadRow();
    return;
  }
  deviceDetailDumpLoadOpt.selected = optedIn;
  applyDumpLoadDisabledState(params.deviceId);
};

// The full valid blob entry a fresh dump-load opt-in writes: price-response off
// and zero deltas (NOT the temperature defaults — a binary device has no
// setpoint), with only `surplusWilling` carrying meaning. An existing entry
// keeps its other fields and only flips `surplusWilling`.
const buildDumpLoadConfig = (
  existing: PriceOptimizationConfig | undefined,
  surplusWilling: boolean,
): PriceOptimizationConfig => (
  existing
    ? { ...existing, surplusWilling }
    : { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling }
);

const initDeviceDetailDumpLoadHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  const autoSaveDumpLoad = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailDumpLoadOpt) return;
    const device = params.getDeviceById(deviceId);
    const controlState = resolveDeviceDetailControlState(device, deviceId);
    // Shape-only (not the solar-offer gate): a user opting OUT while the solar
    // device has disappeared must still be able to save — the escape hatch would
    // be dead otherwise (isDumpLoadCandidateDevice would reject the opt-out).
    if (!isDumpLoadDeviceShape(device, controlState)) return;

    const surplusWilling = deviceDetailDumpLoadOpt.selected;
    const previous = state.priceOptimizationSettings[deviceId];
    state.priceOptimizationSettings[deviceId] = buildDumpLoadConfig(previous, surplusWilling);

    try {
      await savePriceOptimizationSettings();
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailDumpLoadControl({ deviceId, getDeviceById: params.getDeviceById });
      }
    } catch (error) {
      // Roll back only if no newer edit landed while the save was in flight
      // (mirrors the temperature surplus handler above).
      const current = state.priceOptimizationSettings[deviceId];
      if (current && current.surplusWilling === surplusWilling) {
        if (previous) {
          state.priceOptimizationSettings[deviceId] = previous;
        } else {
          delete state.priceOptimizationSettings[deviceId];
        }
      }
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailDumpLoadControl({ deviceId, getDeviceById: params.getDeviceById });
      }
      await logSettingsError('Failed to save solar surplus settings', error, 'device detail');
      await showToastError(error, 'Failed to save solar surplus settings.');
    }
  };

  deviceDetailDumpLoadOpt?.addEventListener('change', autoSaveDumpLoad);
};
