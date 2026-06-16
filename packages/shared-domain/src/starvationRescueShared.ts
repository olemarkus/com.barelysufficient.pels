import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../contracts/src/deferredObjectivePlanPreview';
import type {
  StarvationRescueDevice,
  StarvationRescueRejectReason,
} from '../../contracts/src/starvationRescue';
import { starvationRowIsRescuable } from './planStarvation';

// One home for the BUDGET-EXEMPT RESCUE's server-side resolution shared by the
// two surfaces that offer it: the standalone `starvation_rescue` dashboard
// widget (`widgets/starvation_rescue/src/api.ts`) and the overview device-card
// chip path (`api.ts` → `setup/settingsUiApi.ts`). Both surfaces run in the app
// process and reach the same app methods (`previewStarvationRescuePlan`,
// `rescueDeviceWithBudgetExemption`, `getStarvedRescueDevices`); factoring the
// request parsing, candidate building, rescuable-device gating, and reason
// mapping here keeps the guardrail SINGLE-HOMED so the two surfaces cannot drift
// in what they let through.
//
// Everything here is BROWSER-SAFE and pure (no Homey/SDK references): it takes
// the already-fetched starved-device list as data and returns plain values, so
// the widget's WebView gate and the settings-UI gate can reuse it too.

// Near-term deadline for an active rescue: 3 hours gives a thermal device room
// to recover toward its normal target without promising an instant fix, while
// staying "now"-shaped (a rescue, not a scheduled overnight task). Shared so the
// horizon the create lane validates against matches the one the preview resolves.
export const RESCUE_DEADLINE_HORIZON_MS = 3 * 60 * 60 * 1000;

// The rescue request the surfaces POST. The browser never resolves the rescue's
// TARGET (the device's intended normal target is resolved SERVER-SIDE so the
// client can't smuggle an arbitrary target past the budget-cause guardrail).
//
// `deadlineAtMs` is the deadline the PREVIEW resolved and the user saw. The
// create path echoes it back rather than recomputing a fresh now+3h, so a
// confirm left open across an hour boundary persists the exact previewed
// deadline/cost — or is rejected (`deadline_passed`) and re-previewed if it has
// since slipped past or out of the rescue horizon. Omitted on a preview request.
export type StarvationRescueRequest = {
  deviceId: string;
  deadlineAtMs?: number;
};

export const parseRescueRequest = (body: unknown): StarvationRescueRequest | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Partial<StarvationRescueRequest>;
  const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId.trim() : '';
  if (!deviceId) return null;
  // `deadlineAtMs` is optional (preview omits it); when present it must be a
  // finite number — the create path validates it's still future + in-horizon.
  const deadlineAtMs = typeof candidate.deadlineAtMs === 'number' && Number.isFinite(candidate.deadlineAtMs)
    ? candidate.deadlineAtMs
    : undefined;
  return deadlineAtMs === undefined ? { deviceId } : { deviceId, deadlineAtMs };
};

export type ResolvedRescuableDevice =
  | { ok: true; targetTemperatureC: number }
  | { ok: false; reason: StarvationRescueRejectReason };

// Confirm the requested device is a rescuable (budget-caused, task-free) starved
// row with a known target against the LIVE starved list. This is the guardrail's
// enforcement point: run on both preview and create so a stale or tampered
// request can never build a budget-exempt rescue for a capacity row, a device
// that already recovered, or one that already has its own smart task. Pure over
// the supplied list — `null` means the app getter was unavailable.
export const resolveRescuableDeviceFromList = (
  devices: StarvationRescueDevice[] | null,
  deviceId: string,
): ResolvedRescuableDevice => {
  if (devices === null) return { ok: false, reason: 'unavailable' };
  const device = devices.find((entry) => entry.deviceId === deviceId);
  // `starvationRowIsRescuable` is the full actionable predicate the surfaces' UI
  // gates also use (budget cause AND task-free AND a known finite target), so a
  // shown affordance and this enforcement agree by construction.
  if (!device || !starvationRowIsRescuable(device.cause, device.intendedNormalTargetC, device.hasSmartTask)) {
    if (device && device.cause === 'budget' && !device.hasSmartTask
      && (device.intendedNormalTargetC === null || !Number.isFinite(device.intendedNormalTargetC))) {
      return { ok: false, reason: 'no_target' };
    }
    return { ok: false, reason: 'not_rescuable' };
  }
  // `starvationRowIsRescuable` already proved the target is a finite number.
  return { ok: true, targetTemperatureC: device.intendedNormalTargetC as number };
};

// Build the rescue candidate: a soft temperature objective aimed at the device's
// intended normal target, carrying `exemptFromBudget: 'always'` to bypass
// daily-budget admission while it's scheduled. The OTHER rescue permission —
// `limitLowerPriorityDevices` (the boost) — is added SERVER-SIDE only for
// stepped-eligible devices (see `App.deviceSupportsLimitLowerPriority`); the
// surfaces can't see the device profile, so they never grant it here. 'always'
// (not 'at_risk') because the user is explicitly asking for power NOW on an
// already-starved device — there is no "wait until at risk" to defer to.
export const buildRescueCandidate = (
  targetTemperatureC: number,
  deadlineAtMs: number,
): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC,
  deadlineAtMs,
  // The rescue requests BOTH permissions; the create engine's
  // `gateCandidateExtraPermissions` keeps `exemptFromBudget` for any device and
  // the `limitLowerPriorityDevices` grant only where it has effect (stepped-load
  // + top priority), so the surfaces never need the device profile here.
  rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
});

// Map a `rescueDeviceWithBudgetExemption` rejection reason onto the surfaces'
// reject-reason union. The per-key write refused to persist (transient
// un-confirmable migration / untrustworthy settings read) → map onto the
// retryable `write_conflict` lane so the user gets the "try again" copy.
export const mapAppRescueReason = (reason: string): StarvationRescueRejectReason => {
  if (reason === 'device_not_found') return 'device_not_found';
  if (reason === 'device_not_planned') return 'device_not_planned';
  if (reason === 'device_not_eligible') return 'device_not_eligible';
  if (reason === 'write_conflict' || reason === 'write_refused') return 'write_conflict';
  return 'invalid_candidate';
};
