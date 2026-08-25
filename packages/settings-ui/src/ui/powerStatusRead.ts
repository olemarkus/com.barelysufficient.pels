/**
 * Client seam for the classified power-status read
 * (`SettingsUiPowerStatusRead`, packages/contracts/src/settingsUiApi.ts).
 *
 * The producer (setup/settingsUiApi.ts) classifies the persisted `pels_status`
 * blob at the read boundary: `live` means the home's measurement gate is open
 * and the running planner vouches for the blob; `unavailable` names exactly why
 * no live claim exists (gated boot / never sampled this run, no blob committed,
 * scoped read refused, or a failed WebView read). This module is the ONE place
 * the WebView validates that shape off its untrusted transports (the Homey API
 * bridge, realtime pushes) and translates it into the view layer's existing
 * absence vocabulary.
 */
import type {
  SettingsUiPowerStatus,
  SettingsUiPowerStatusRead,
} from '../../../contracts/src/settingsUiApi.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'no_measurement',
  'no_status_recorded',
  'home_scope_unavailable',
  'read_failed',
]);

export const isPowerStatusRead = (value: unknown): value is SettingsUiPowerStatusRead => {
  if (!isRecord(value)) return false;
  if (value.state === 'live') return isRecord(value.status);
  if (value.state === 'unavailable') {
    return typeof value.reason === 'string' && UNAVAILABLE_REASONS.has(value.reason);
  }
  return false;
};

/**
 * Classify an untrusted pushed/fetched `status` member once, at this seam. A
 * malformed or missing value is the client's own read failure — never a live
 * status, and never a fabricated producer reason.
 */
export const resolvePowerStatusRead = (value: unknown): SettingsUiPowerStatusRead => (
  isPowerStatusRead(value) ? value : { state: 'unavailable', reason: 'read_failed' }
);

/**
 * Narrow a classified read into the view layer's PRE-EXISTING nullable status
 * vocabulary (`SettingsUiPowerStatus | null`): every rendering path in this
 * package already treats `null` as "no live status" honestly (hero falls back
 * to the plan meta's own freshness, chips stay calm, the stale-data banner
 * keeps its tracker-first derivation). The `null` here is that existing
 * vocabulary, not a new modelling choice — new seam code carries the
 * discriminated union.
 *
 * Takes `unknown` on purpose: callers hold values off the untrusted Homey API
 * bridge, so the narrowing IS the seam validation (`isPowerStatusRead`) — a
 * malformed or missing value yields the same honest `null`, never a throw.
 */
export const liveStatusOrNull = (value: unknown): SettingsUiPowerStatus | null => (
  isPowerStatusRead(value) && value.state === 'live' ? value.status : null
);
