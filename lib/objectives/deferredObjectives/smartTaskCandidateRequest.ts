import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  SmartTaskCandidateRequest,
  SmartTaskWriteRejectReason,
} from '../../../packages/contracts/src/smartTaskEdit';
import { resolveDeferredObjectiveDeadline } from './deadline';
import {
  normalizeDeferredObjectiveSettingsEntry,
} from '../../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import type {
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsKind,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';

/**
 * Shared server-side handling of a UI-composed smart-task candidate request
 * (the create_smart_task widget and the settings-UI edit lane): shape-validate
 * the body, resolve the local "Ready by" HH:mm to an absolute deadline against
 * the Homey timezone (DST-aware — the browser never does timezone math), and
 * build the validated preview/persist candidate. The app methods these feed
 * (`previewDeferredObjectivePlan`, `createDeferredObjective`) stay the single
 * source of truth for projection and persistence.
 */

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Outer bound for a client-echoed previewed deadline. The "Ready by" resolver
// only ever places a deadline within the next ~24h (today, or rolled to
// tomorrow); 36h absorbs a 25-hour DST day plus slack while still rejecting an
// implausible or tampered far-future timestamp. The client deadline is never
// trusted as the persisted value beyond `(now, now + MAX_DEADLINE_HORIZON_MS]`.
const MAX_DEADLINE_HORIZON_MS = 36 * 60 * 60 * 1000;

const isObjectiveKind = (value: unknown): value is DeferredObjectiveSettingsKind => (
  value === 'temperature' || value === 'ev_soc' || value === 'energy'
);

// Parse and shape-validate the candidate request body. Returns null on any
// malformed field; the deeper range/eligibility validation happens in the app
// methods (via the shared normalizer + device-kind check), so this only guards
// against structurally-invalid input reaching them.
export const parseSmartTaskCandidateRequest = (body: unknown): SmartTaskCandidateRequest | null => {
  if (!isUnknownRecord(body)) return null;
  const candidate = body as Partial<SmartTaskCandidateRequest>;
  const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId.trim() : '';
  if (!deviceId) return null;
  if (!isObjectiveKind(candidate.kind)) return null;
  if (typeof candidate.target !== 'number' || !Number.isFinite(candidate.target)) return null;
  const readyByLocalTime = typeof candidate.readyByLocalTime === 'string'
    ? candidate.readyByLocalTime.trim()
    : '';
  if (!LOCAL_TIME_PATTERN.test(readyByLocalTime)) return null;
  // Carry the optional client-echoed previewed deadline only when it is a finite
  // number; any other shape is dropped (the create path then re-resolves from
  // `readyByLocalTime`). Range/freshness validation happens in `resolveSmartTaskWriteDeadline`.
  const deadlineAtMs = typeof candidate.deadlineAtMs === 'number' && Number.isFinite(candidate.deadlineAtMs)
    ? candidate.deadlineAtMs
    : undefined;
  // "Extra permissions": ABSENT and `false` are DIFFERENT — absent says nothing
  // about that permission (it keeps whatever it holds), while an explicit
  // `false` revokes. `buildCandidateRescue` owns that resolution. Because the
  // two mean opposite things, a PRESENT-but-malformed value (`null`,
  // `"false"`, `0`) cannot be folded into either: reading it as absent would
  // silently preserve a grant the caller may have meant to drop. Reject the
  // whole request instead, the same way a bad `kind`/`target` does. Eligibility
  // for limit-lower-priority is re-gated server-side against the device, so a
  // tampered `true` here can never persist a permission the device can't honour.
  if (!permissionsAreWellFormed(candidate)) return null;
  return {
    deviceId,
    kind: candidate.kind,
    target: candidate.target,
    readyByLocalTime,
    deadlineAtMs,
    exemptFromBudget: readPermission(candidate.exemptFromBudget),
    limitLowerPriorityDevices: readPermission(candidate.limitLowerPriorityDevices),
    pauseLowerPriorityDevices: readPermission(candidate.pauseLowerPriorityDevices),
  };
};

// The quick-target request: the device and the goal the creation surface shows
// for it. The kind is the surface's, not re-derived here: a charger's offered
// goal follows its battery level (`resolveSmartTaskCreationKind`), and targets
// timed for a goal the surface no longer shows would be labelled and created as
// the wrong one.
export const parseSmartTaskQuickTargetsRequest = (
  body: unknown,
): Pick<SmartTaskCandidateRequest, 'deviceId' | 'kind'> | null => {
  if (!isUnknownRecord(body)) return null;
  const request = body as Partial<SmartTaskCandidateRequest>;
  const deviceId = typeof request.deviceId === 'string' ? request.deviceId.trim() : '';
  if (!deviceId || !isObjectiveKind(request.kind)) return null;
  return { deviceId, kind: request.kind };
};

// A permission slot is well-formed only when it is absent or a literal boolean.
// `undefined` covers both "key omitted" and "key present as undefined"; the two
// are indistinguishable over the JSON body and mean the same thing here.
const isPermissionValue = (value: unknown): value is boolean | undefined => (
  value === undefined || typeof value === 'boolean'
);

const permissionsAreWellFormed = (candidate: Partial<SmartTaskCandidateRequest>): boolean => (
  isPermissionValue(candidate.exemptFromBudget)
  && isPermissionValue(candidate.limitLowerPriorityDevices)
  && isPermissionValue(candidate.pauseLowerPriorityDevices)
);

const readPermission = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

// Resolve the request's local ready-by time to a future absolute deadline.
// Returns null when the time can't be placed in the future (should not happen
// for a valid HH:mm given the resolver rolls to tomorrow, but guarded).
export const resolveSmartTaskRequestDeadline = (
  request: SmartTaskCandidateRequest,
  timeZone: string,
  nowMs: number,
): number | null => {
  const resolution = resolveDeferredObjectiveDeadline(nowMs, timeZone, request.readyByLocalTime);
  if (resolution.deadlineAtMs === null || resolution.deadlineAtMs <= nowMs) return null;
  return resolution.deadlineAtMs;
};

// Resolve the deadline a WRITE (create/update) will persist. When the client
// echoes back the deadline the preview showed (`request.deadlineAtMs`), use
// that exact value so the persisted task can never disagree with the previewed
// window — but only after validating it is still strictly in the future and
// within a sane horizon. A previewed time that slipped into the past while the
// user lingered (the same-minute boundary case) is rejected with
// `deadline_passed` rather than silently re-resolved to tomorrow. When no
// client deadline is supplied (direct API callers with no preview step), fall
// back to server-side re-resolution from `readyByLocalTime` (`invalid_ready_by`
// when unresolvable).
export const resolveSmartTaskWriteDeadline = (
  request: SmartTaskCandidateRequest,
  timeZone: string,
  nowMs: number,
): { ok: true; deadlineAtMs: number } | { ok: false; reason: SmartTaskWriteRejectReason } => {
  if (request.deadlineAtMs !== undefined) {
    if (request.deadlineAtMs <= nowMs || request.deadlineAtMs > nowMs + MAX_DEADLINE_HORIZON_MS) {
      return { ok: false, reason: 'deadline_passed' };
    }
    return { ok: true, deadlineAtMs: request.deadlineAtMs };
  }
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return { ok: false, reason: 'invalid_ready_by' };
  return { ok: true, deadlineAtMs };
};

// Absence preserves a standing mode; false revokes. An editor's true keeps
// the existing mode, whereas an explicit creation grant upgrades to always.
const resolveGrantedMode = (
  requested: boolean | undefined,
  current: DeferredObjectiveRescueMode | undefined,
  grantMode: 'preserve' | 'always',
): DeferredObjectiveRescueMode | undefined => {
  if (requested === undefined) return current;
  if (!requested) return undefined;
  return grantMode === 'always' ? 'always' : current ?? 'always';
};

// Resolve the candidate's COMPLETE `rescue` field from the request plus the
// task's standing permissions. Per-key: an unmentioned permission survives, an
// explicit `false` revokes. This is the single owner of that merge — callers
// write the result verbatim (`rescue: 'replace'`) rather than re-deriving it, so
// the preview and the persist can't diverge. `undefined` when nothing is granted.
//
// Creation grants explicitly upgrade to always; edits preserve existing modes.
const buildCandidateRescue = (
  request: SmartTaskCandidateRequest,
  standing: DeferredObjectiveRescuePermissions | undefined,
  grantMode: 'preserve' | 'always',
): DeferredObjectiveRescuePermissions | undefined => {
  const exemptFromBudget = resolveGrantedMode(request.exemptFromBudget, standing?.exemptFromBudget, grantMode);
  const limitLowerPriorityDevices = resolveGrantedMode(
    request.limitLowerPriorityDevices,
    standing?.limitLowerPriorityDevices,
    grantMode,
  );
  const pauseLowerPriorityDevices = resolveGrantedMode(
    request.pauseLowerPriorityDevices,
    standing?.pauseLowerPriorityDevices,
    grantMode,
  );
  if (!exemptFromBudget && !limitLowerPriorityDevices && !pauseLowerPriorityDevices) return undefined;
  return {
    ...(exemptFromBudget ? { exemptFromBudget } : {}),
    ...(limitLowerPriorityDevices ? { limitLowerPriorityDevices } : {}),
    ...(pauseLowerPriorityDevices ? { pauseLowerPriorityDevices } : {}),
  };
};

// A kind's one `target` number read as the kind's own target field. No
// permissions: a caller that has them adds `rescue`.
export const buildSmartTaskCandidateBase = (
  kind: DeferredObjectiveSettingsKind,
  target: number,
  deadlineAtMs: number,
): DeferredObjectivePlanPreviewCandidate => {
  switch (kind) {
    case 'ev_soc':
      return { kind: 'ev_soc', enforcement: 'soft', targetPercent: target, deadlineAtMs };
    case 'temperature':
      return { kind: 'temperature', enforcement: 'soft', targetTemperatureC: target, deadlineAtMs };
    case 'energy':
      return { kind: 'energy', enforcement: 'soft', targetEnergyKWh: target, deadlineAtMs };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

// Build and VALIDATE the preview/persist candidate (the settings entry shape
// minus `enabled`) from a request + resolved deadline. Validation runs through
// the same `normalizeDeferredObjectiveSettingsEntry` the create path uses, so a
// preview and a create reject identical out-of-range targets — the user never
// sees an optimistic preview for a candidate the create would reject. Returns
// null when the per-kind target is out of range. The runtime create path
// re-validates and additionally checks device-kind eligibility.
export const buildValidSmartTaskCandidate = (
  request: SmartTaskCandidateRequest,
  deadlineAtMs: number,
  // Current permissions are merged per key; creation explicitly upgrades a
  // selected permission while editing retains the mode of a left-on toggle.
  standingRescue?: DeferredObjectiveRescuePermissions,
  grantMode: 'preserve' | 'always' = 'preserve',
): DeferredObjectivePlanPreviewCandidate | null => {
  const base = buildSmartTaskCandidateBase(request.kind, request.target, deadlineAtMs);
  const rescue = buildCandidateRescue(request, standingRescue, grantMode);
  const candidate: DeferredObjectivePlanPreviewCandidate = rescue ? { ...base, rescue } : base;
  return normalizeDeferredObjectiveSettingsEntry({ ...candidate, enabled: true }) ? candidate : null;
};

// Map a `createDeferredObjective` rejection onto the shared UI reject
// vocabulary. The per-key write's refusal (a transient untrustworthy settings
// read) maps onto the retryable `write_conflict` lane so
// the user gets the "try again" copy rather than a false success.
export const mapSmartTaskAppReason = (reason: string): SmartTaskWriteRejectReason => {
  if (reason === 'device_not_found') return 'device_not_found';
  if (reason === 'device_not_planned') return 'device_not_planned';
  if (reason === 'device_not_eligible') return 'device_not_eligible';
  // Multi-home v1 scope rejection — passed through typed so the surfaces show
  // the dedicated "separate meter" copy, never the retry framing.
  if (reason === 'device_in_sub_home') return 'device_in_sub_home';
  if (reason === 'write_conflict' || reason === 'write_refused') return 'write_conflict';
  return 'invalid_candidate';
};
