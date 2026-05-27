/**
 * Thin re-export shim. The canonical home for observation-trust helpers is
 * `lib/utils/observationTrust.ts` so both `lib/observer/` and `lib/device/`
 * can import a single source (the latter cannot import `lib/observer/` per
 * the `no-device-to-peer-except-power` layering rule).
 *
 * Existing observer-side call sites continue to import from here; new
 * consumers should prefer `lib/utils/observationTrust` directly.
 */
export { isDeviceObservationTrusted } from '../utils/observationTrust';
