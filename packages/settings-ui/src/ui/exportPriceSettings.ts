// Export (feed-in) price settings for the settings UI's "Export price" section
// (`ElectricityPricesView`). Mirrors the per-domain shape of
// `priceSettingsPersistence.ts`: raw setting reads are normalized/finiteness-
// gated here at the boundary, and inputs are range-checked before any write so
// junk never reaches the persisted store. The runtime producer counterpart is
// `lib/price/exportPrice.ts` (readExportPriceConfig) — same keys, same
// semantics: `spotFactorPercent = 0` is the pure fixed-tariff case and `fixed`
// is signed (negative ⇒ the home pays to export).

import { getSetting, setSetting } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import {
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys.ts';

export type ExportPriceSettings = {
  enabled: boolean;
  spotFactorPercent: number;
  fixed: number;
};

export const EXPORT_SPOT_FACTOR_MIN = 0;
export const EXPORT_SPOT_FACTOR_MAX = 200;
// Loose sanity bound for the signed fixed component, matching the scale of the
// existing min-diff bound (0–1000 øre). Sign is legitimate either way.
export const EXPORT_FIXED_LIMIT = 1000;

const finiteNumberSetting = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

export const readExportPriceSettings = async (): Promise<ExportPriceSettings> => {
  const [enabledRaw, spotFactorRaw, fixedRaw] = await Promise.all([
    getSetting(EXPORT_PRICE_ENABLED),
    getSetting(EXPORT_SPOT_FACTOR),
    getSetting(EXPORT_FIXED),
  ]);
  return {
    enabled: enabledRaw === true,
    spotFactorPercent: finiteNumberSetting(spotFactorRaw, 0),
    fixed: finiteNumberSetting(fixedRaw, 0),
  };
};

// Boundary validation for the numeric fields. Throws a user-facing message
// (surfaced through the error toast) so an out-of-range or non-finite value is
// rejected before the settings write.
export const validateExportSpotFactor = (value: number): void => {
  if (!Number.isFinite(value) || value < EXPORT_SPOT_FACTOR_MIN || value > EXPORT_SPOT_FACTOR_MAX) {
    throw new Error(
      `Share of spot price must be between ${EXPORT_SPOT_FACTOR_MIN} and ${EXPORT_SPOT_FACTOR_MAX}%.`,
    );
  }
};

export const validateExportFixed = (value: number): void => {
  if (!Number.isFinite(value) || Math.abs(value) > EXPORT_FIXED_LIMIT) {
    // "in your price unit" keeps the bound meaningful without knowing the
    // active scheme's unit at validation time (øre/kWh on Norway; source unit
    // on flow/homey).
    throw new Error(
      `Fixed amount must be between -${EXPORT_FIXED_LIMIT} and ${EXPORT_FIXED_LIMIT} in your price unit.`,
    );
  }
};

export type ExportPriceStatePatch = Partial<{
  exportPriceEnabled: boolean;
  exportSpotFactor: number;
  exportFixed: number;
}>;

// ─── Scheme-change transition ────────────────────────────────────────────────
//
// Crossing the Norway unit boundary changes what an enabled export config
// means — in EITHER direction:
//   • A non-zero fixed amount was entered in the unit of the scheme that was
//     active at the time: øre/kWh (divisor 100) on Norway, the source unit
//     (divisor 1) on flow/homey. Carried raw across the boundary, "−5 øre"
//     becomes "−5 source-units" and "0.50 NOK" is re-read as "0.50 øre"
//     (100× off). Export pricing turns OFF instead; the stored numbers stay
//     inert so returning to the entry scheme only needs a re-enable.
//   • A pure spot-share config (fixed = 0) is a unitless percent, so it
//     crosses safely — but a spot-linked share without an isolatable spot
//     yields NO export price at all (lib/price/exportPrice.ts), so entering
//     a spot-less scheme normalizes the share to 0. Entering Norway a stored
//     share is meaningful again: no action.
// The resolver is pure (unit-testable); the executor performs the follow-up
// write and hands the orchestrator the matching state patch + toast. Both
// writes run only AFTER the scheme save itself lands (see handleSchemeChange).
// `previousScheme` must be the PERSISTED scheme (the stored fixed amount's
// unit follows the scheme active when it was entered) — after a failed save
// the optimistic UI scheme can diverge from the store.

export type ExportSchemeChangePlan = 'none' | 'disable_export' | 'normalize_share';

export const resolveExportSchemeChangePlan = (params: {
  previousScheme: string;
  nextScheme: string;
  exportPriceEnabled: boolean;
  exportSpotFactor: number;
  exportFixed: number;
}): ExportSchemeChangePlan => {
  if (!params.exportPriceEnabled) return 'none';
  const crossesUnitBoundary = (params.previousScheme === 'norway') !== (params.nextScheme === 'norway');
  if (crossesUnitBoundary && params.exportFixed !== 0) return 'disable_export';
  if (params.nextScheme !== 'norway' && params.exportSpotFactor !== 0) return 'normalize_share';
  return 'none';
};

export const EXPORT_DISABLED_ON_SCHEME_CHANGE_TOAST = 'Price settings saved. Export price turned off — '
  + 'its units differ between price sources; re-enter it under Electricity prices.';
export const EXPORT_SHARE_NORMALIZED_TOAST = 'Price settings saved. Export share of spot set to 0 — '
  + 'this price source has no spot price.';

export const applyExportSchemeChangePlan = async (
  plan: ExportSchemeChangePlan,
): Promise<{ patch: ExportPriceStatePatch; toast: string }> => {
  if (plan === 'disable_export') {
    await setSetting(EXPORT_PRICE_ENABLED, false);
    return { patch: { exportPriceEnabled: false }, toast: EXPORT_DISABLED_ON_SCHEME_CHANGE_TOAST };
  }
  if (plan === 'normalize_share') {
    await setSetting(EXPORT_SPOT_FACTOR, 0);
    return { patch: { exportSpotFactor: 0 }, toast: EXPORT_SHARE_NORMALIZED_TOAST };
  }
  return { patch: {}, toast: 'Price settings saved.' };
};

// Compensating rollback of the scheme write (used by `recoverFromSchemeChangeFailure`).
// The scheme save and the `applyExportSchemeChangePlan` follow-up cannot be atomic:
// when the scheme lands but the export write fails, the store is left holding the
// NEW scheme beside an export config still in the OLD unit — an incoherent pair
// whose fixed amount a later read would scale by the wrong divisor. Re-persist
// `previousScheme` (the value the untouched export config still agrees with), never
// wiping the export config. A no-op scheme change needs no rollback. Best-effort —
// a failed rollback is logged, never destructively retried.
const rollBackSchemeOnExportFailure = async (
  previousScheme: string,
  nextScheme: string,
): Promise<boolean> => {
  if (previousScheme === nextScheme) return false;
  try {
    await setSetting(PRICE_SCHEME, previousScheme);
    return true;
  } catch (rollbackError) {
    await logSettingsError('Failed to roll back price scheme', rollbackError, 'priceConfig');
    return false;
  }
};

// Reconcile the persisted store + optimistic UI after a FAILED `handleSchemeChange`,
// applying any compensating write. Returns true iff the caller should restore
// `configState.priceScheme` to `previousScheme`. Guards two edges the reviewers
// surfaced:
//  - a newer scheme change may have superseded this call while it awaited the
//    export follow-up (`currentScheme !== scheme`) ⇒ never clobber the newer choice;
//  - if the scheme write itself never landed (`!schemePersisted`), the store never
//    changed — only the optimistic UI needs reverting, with no compensating write.
export const recoverFromSchemeChangeFailure = async (params: {
  scheme: string;
  currentScheme: string;
  previousScheme: string | undefined;
  schemePersisted: boolean;
}): Promise<boolean> => {
  const { scheme, currentScheme, previousScheme, schemePersisted } = params;
  if (currentScheme !== scheme || previousScheme === undefined) return false;
  if (!schemePersisted) return true; // scheme save failed: revert optimistic UI only
  return rollBackSchemeOnExportFailure(previousScheme, scheme);
};

export type ExportPriceHandlersContext = {
  // Read the orchestrator's current view of the export config + active scheme.
  getState: () => {
    priceScheme: string;
    exportPriceEnabled: boolean;
    exportSpotFactor: number;
    exportFixed: number;
  };
  // Merge a patch into the orchestrator's config state.
  patchState: (patch: ExportPriceStatePatch) => void;
  // Repaint the electricity-prices surface after an optimistic patch/rollback.
  rerender: () => void;
};

// A numeric export field as the view hands it over (the md-filled-text-field
// element). Needed for snap-back: Preact's retained VDOM won't rewrite a value
// prop that didn't change, so a rejected or unsaved value must be reset on the
// element itself before the repaint.
type ExportNumberField = { value: string };

// The three change handlers for the view's export section, extracted here so
// `priceConfig.ts` only wires them (config state + repaint stay orchestrator-
// owned via the context callbacks).
export const createExportPriceHandlers = (ctx: ExportPriceHandlersContext) => {
  // Snap the field back to the stored value after a rejected or failed save.
  const revertField = (key: string, field: ExportNumberField): void => {
    const state = ctx.getState();
    // Local alias: the write must land on the element itself (see
    // ExportNumberField above); `no-param-reassign` guards params only.
    const target = field;
    target.value = String(key === EXPORT_SPOT_FACTOR ? state.exportSpotFactor : state.exportFixed);
    ctx.rerender();
  };

  const saveNumber = async (
    key: string,
    patch: ExportPriceStatePatch,
    validate: (val: number) => void,
    val: number,
    field: ExportNumberField,
  ): Promise<void> => {
    try {
      validate(val);
      // Commit to config state only after the write lands — a failed write
      // must never repaint the unsaved value as saved.
      await setSetting(key, val);
      ctx.patchState(patch);
      // Repaint: the committed value can change dependent presentation, e.g.
      // a spot-less scheme's share settling at 0 flips the field to its
      // disabled fixed-only state (the stale-share repair path).
      ctx.rerender();
      await showToast('Export price settings saved.', 'ok');
    } catch (error) {
      revertField(key, field);
      await logSettingsError(`Failed to save ${key}`, error, 'exportPriceSettings');
      await showToastError(error, 'Failed to save export price settings.');
    }
  };

  const onEnabledChange = async (enabled: boolean): Promise<void> => {
    const previous = ctx.getState();
    // On the flow/homey sources no hourly spot is isolatable, so a spot-linked
    // share can't produce an export price at all (lib/price/exportPrice.ts).
    // Enabling there normalizes the persisted share to the fixed-tariff case
    // (0), keeping the disabled field's "only the fixed amount applies" hint
    // true.
    const spotFactor = !enabled || previous.priceScheme === 'norway' ? previous.exportSpotFactor : 0;
    ctx.patchState({ exportPriceEnabled: enabled, exportSpotFactor: spotFactor });
    ctx.rerender();
    let enabledWriteLanded = false;
    try {
      // Enabled flag first: if the follow-up normalization write fails, the
      // stored share survives untouched (fail-safe) rather than being zeroed
      // under a half-applied toggle.
      await setSetting(EXPORT_PRICE_ENABLED, enabled);
      enabledWriteLanded = true;
      if (spotFactor !== previous.exportSpotFactor) await setSetting(EXPORT_SPOT_FACTOR, spotFactor);
      await showToast(enabled ? 'Export price enabled.' : 'Export price disabled.', 'ok');
    } catch (error) {
      // Make the UI truthful about what actually persisted.
      if (enabledWriteLanded) {
        // The toggle landed but the normalization write failed. Compensate:
        // best-effort roll the persisted toggle back to its pre-call value so
        // showing the pre-call UI state is truthful again.
        try {
          await setSetting(EXPORT_PRICE_ENABLED, previous.exportPriceEnabled);
          ctx.patchState({
            exportPriceEnabled: previous.exportPriceEnabled,
            exportSpotFactor: previous.exportSpotFactor,
          });
        } catch {
          // Rollback write also failed: show the state we KNOW persisted —
          // the new toggle value with the untouched stored share — rather
          // than a pre-call state the store no longer holds.
          ctx.patchState({ exportPriceEnabled: enabled, exportSpotFactor: previous.exportSpotFactor });
        }
      } else {
        // Nothing persisted; the pre-call state is the truth.
        ctx.patchState({
          exportPriceEnabled: previous.exportPriceEnabled,
          exportSpotFactor: previous.exportSpotFactor,
        });
      }
      ctx.rerender();
      await logSettingsError('Failed to save export price toggle', error, 'exportPriceSettings');
      await showToastError(error, 'Failed to save export price settings.');
    }
  };

  return {
    onEnabledChange,
    onSpotFactorChange: (val: number, field: ExportNumberField): Promise<void> => (
      saveNumber(EXPORT_SPOT_FACTOR, { exportSpotFactor: val }, validateExportSpotFactor, val, field)
    ),
    onFixedChange: (val: number, field: ExportNumberField): Promise<void> => (
      saveNumber(EXPORT_FIXED, { exportFixed: val }, validateExportFixed, val, field)
    ),
  };
};
