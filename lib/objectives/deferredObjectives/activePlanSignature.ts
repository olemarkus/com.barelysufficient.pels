import type { DeferredObjectiveRescuePermissions } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveProgressDirectionRead } from '../types';

type ObjectiveSignatureParams = {
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
  progressDirection: ObjectiveProgressDirectionRead;
  rescue?: DeferredObjectiveRescuePermissions;
};

// Tuple-shape of `buildRescueSignatureSegment`'s output. Kept as a tagged tuple
// (rather than an object) so the persisted signature string stays a tiny JSON
// array — the recorder rewrites the field on every revision and the persisted
// form has shipped this layout since the rescue permission feature landed.
type RescueSegment =
  | ['rescue', string | null, string | null]
  | ['rescue', string | null, string | null, string | null];

const buildRescueSignatureSegment = (
  rescue: DeferredObjectiveRescuePermissions | undefined,
): RescueSegment | null => {
  const exemptFromBudget = rescue?.exemptFromBudget ?? null;
  const limitLowerPriorityDevices = rescue?.limitLowerPriorityDevices ?? null;
  const pauseLowerPriorityDevices = rescue?.pauseLowerPriorityDevices ?? null;
  if (!exemptFromBudget && !limitLowerPriorityDevices && !pauseLowerPriorityDevices) return null;
  // Append `pause` only when set, so existing tasks (exempt/limit only) keep their shipped
  // 3-tuple signature and don't churn a spurious `flow_permission_changed` revision on deploy;
  // toggling `pause` is itself a real permission change and correctly re-versions the plan.
  return pauseLowerPriorityDevices
    ? ['rescue', exemptFromBudget, limitLowerPriorityDevices, pauseLowerPriorityDevices]
    : ['rescue', exemptFromBudget, limitLowerPriorityDevices];
};

export const buildObjectiveSignature = (params: ObjectiveSignatureParams): string => {
  const base = [
    params.objectiveKind,
    params.targetTemperatureC,
    params.targetPercent,
    params.deadlineAtMs,
    params.enforcement,
    params.progressDirection,
  ];
  const rescue = buildRescueSignatureSegment(params.rescue);
  return JSON.stringify(rescue ? [...base, rescue] : base);
};

// Internal: parse a signature string into its (base, rescue) parts. Used by
// `compareObjectiveSignatures` so the recorder can detect when two signatures
// differ only in the rescue segment (i.e. the user toggled a smart-task rescue
// Flow permission and nothing else).
//
// A parsed signature without a trailing rescue tuple is treated as "no rescue
// granted" — that matches the writer side (`buildObjectiveSignature` omits the
// segment when both permissions are null). Returning `null` for `rescue` lets
// the comparison treat absent and explicitly-empty signatures as equivalent
// without re-encoding the persisted form.
type ParsedObjectiveSignature = {
  base: string;
  direction: string;
  rescue: string;
};

// Tolerant of malformed signatures: returns the raw string as `base` with an
// empty `rescue` segment so a corrupt persisted value still produces a stable
// "different" verdict against any well-formed new signature. The recorder
// already handles arbitrary `objectiveChanged` outcomes by writing a fresh
// revision, so a fall-through here is safe.
const parseObjectiveSignature = (signature: string): ParsedObjectiveSignature => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return { base: signature, direction: 'invalid', rescue: 'null' };
  }
  if (!Array.isArray(parsed)) return { base: signature, direction: 'invalid', rescue: 'null' };
  const parts: readonly unknown[] = parsed;
  const tail: unknown = parts.length > 0 ? parts[parts.length - 1] : null;
  const hasRescueTail = Array.isArray(tail) && tail[0] === 'rescue';
  const signatureParts = hasRescueTail ? parts.slice(0, -1) : parts;
  // Signatures written before direction-aware objectives have five base
  // fields. Their milestone trajectory was upward, so preserve that as the
  // legacy direction when comparing against the first direction-aware read.
  const hasDirection = signatureParts.length === 6
    && (signatureParts[5] === 'increasing' || signatureParts[5] === 'decreasing' || signatureParts[5] === 'unknown');
  const baseParts = hasDirection ? signatureParts.slice(0, 5) : signatureParts;
  const direction = hasDirection ? String(signatureParts[5]) : 'increasing';
  const rescueSegment = hasRescueTail ? tail : null;
  return {
    base: JSON.stringify(baseParts),
    direction,
    rescue: JSON.stringify(rescueSegment),
  };
};

export type ObjectiveSignatureDiff = {
  // True when the parsed configurations differ in a plan-relevant way (i.e.
  // the recorder should write a new revision).
  changed: boolean;
  // True when the thermostat's resolved progress direction changed while all
  // user-owned objective fields and Flow permissions stayed the same.
  directionOnly: boolean;
  // True when the signatures differ AND the only differing segment is the
  // rescue tail. Drives the `flow_permission_changed` reason in
  // `maybeWriteReplanRevision`; otherwise the recorder falls back to
  // `objective_changed`. False when both sides are equal.
  rescueOnly: boolean;
};

// Compare two persisted objective signatures and report whether they differ
// and whether the only differing segment is the rescue permission tail. The
// recorder uses this to route a "Flow toggled a rescue permission" replan to
// the dedicated `flow_permission_changed` reason instead of the generic
// `objective_changed` (which the history detail reads as "smart-task settings
// / target changed"). The cheap string-equality fast path keeps the unchanged
// case allocation-free.
export const compareObjectiveSignatures = (
  previous: string,
  next: string,
): ObjectiveSignatureDiff => {
  if (previous === next) return { changed: false, directionOnly: false, rescueOnly: false };
  const prevParts = parseObjectiveSignature(previous);
  const nextParts = parseObjectiveSignature(next);
  const baseChanged = prevParts.base !== nextParts.base;
  const directionChanged = prevParts.direction !== nextParts.direction
    && prevParts.direction !== 'unknown'
    && nextParts.direction !== 'unknown';
  const rescueChanged = prevParts.rescue !== nextParts.rescue;
  return {
    changed: baseChanged || directionChanged || rescueChanged,
    directionOnly: !baseChanged && directionChanged && !rescueChanged,
    rescueOnly: !baseChanged && !directionChanged && rescueChanged,
  };
};
