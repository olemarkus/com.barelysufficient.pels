import type Homey from 'homey';
import { MULTI_HOME_ENABLED } from '../lib/utils/settingsKeys';

/**
 * The hidden multi-home / "Multiple meters" feature flag. DEFAULT FALSE:
 * absent/anything-but-`true` reads as off, mirroring the `*_enabled` flag
 * pattern (`price_optimization_enabled` / `daily_budget_enabled`). One reader
 * so every runtime gate — membership recompute, per-home registry reconcile,
 * the `ui_homes_save` refusal, and the `ui_homes` payload's `multiHomeEnabled`
 * flag — decides identically. Read fresh on each call so a flag flip re-gates
 * the feature on the next membership recompute / registry reconcile.
 */
export const isMultiHomeEnabled = (settings: Homey.App['homey']['settings']): boolean => (
  settings.get(MULTI_HOME_ENABLED) === true
);
