/**
 * Domain-owned read boundary for the capacity scalar settings block
 * (`capacity_limit_kw`, `capacity_margin_kw`, `capacity_dry_run`). Consumers
 * depend on this type, never on `homey.settings` — the interface does not
 * expose the SDK, so capacity code cannot read or normalise the persisted
 * scalars itself. The Homey adapter lives in
 * `setup/capacitySettingsStoreAdapter.ts`.
 *
 * A store instance is scoped to one home at construction time: the main home
 * reads the historical unsuffixed keys, any other home reads home-suffixed
 * keys (`homeScopedSettingsKey` in `lib/utils/settingsKeys.ts`).
 *
 * `read` is junk-tolerant per field: a missing/non-finite scalar (or
 * non-boolean dry-run flag) resolves to the caller-supplied fallback — the
 * last-good snapshot value, seeded from the app defaults — never a fabricated
 * zero. (Root `AGENTS.md` → "Validation belongs at the boundary".)
 */

/**
 * Identifier of a home, re-exported for capacity consumers. Single source of
 * truth in `lib/utils/settingsKeys.ts` (shared with the `lib/home` domain —
 * one identity type, no peer import; the main home is `MAIN_HOME_ID` there).
 */
export type { HomeId } from '../utils/settingsKeys';

/** The capacity scalar block: hard cap, safety margin, and dry-run flag. */
export type CapacityScalarSettings = {
  limitKw: number;
  marginKw: number;
  dryRun: boolean;
};

/**
 * Read access to the capacity scalars for the home the store was constructed
 * for. Each field falls back to the corresponding last-good value when the
 * persisted value is absent or malformed.
 *
 * The last-good provider is bound at construction, next to the homeId, so the
 * home↔fallback pairing is fixed at the wiring site — a caller can never hand
 * one home's values to another home's store at read time. The provider is a
 * wiring-owned closure over already-validated state (the guarded snapshot for
 * the main home; a sub-home's own defaults for sub-homes — never another
 * home's live values) and must therefore always yield finite scalars.
 */
export type CapacitySettingsStore = {
  read(): CapacityScalarSettings;
};
