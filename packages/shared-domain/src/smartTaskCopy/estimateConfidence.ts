// How sure the energy estimate is: the confidence chip and the learning
// provenance rows on the plan-inputs card.
import type { DeferredObjectiveKwhPerUnitProvenanceV1 } from '../../../contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveProfileConfidence } from '../../../contracts/src/objectiveProfileTypes';
import type { SmartTaskListStatusId } from './listStatus';
import { pluralHour } from './valueFormat';

// Confidence chip label shown on the live hero and the Smart-tasks list card.
// Centralised so the two surfaces stay phrased identically. High confidence is
// the normal state and carries no useful chip signal; low / medium confidence
// render as short action-state words rather than bare quality scores.
export const formatConfidenceChipLabel = (
  confidence: ObjectiveProfileConfidence | null | undefined,
): string | null => {
  if (confidence === 'low') return 'Estimating';
  if (confidence === 'medium') return 'Refining';
  return null;
};

// Min accepted samples before the learned rate stops being treated as
// cold-start. Mirrors the planner's variance-buffer floor: below this the rate
// is genuinely provisional ("Estimating"); at or above it the device is
// learned, and a persistently `low` confidence reflects inherent variance, not
// a cold start — so it must not keep nagging.
export const MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP = 4;

// True only during genuine cold-start: the rate is a bootstrap default, or
// fewer than `MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP` accepted samples back it.
// Producer-resolved flat boolean — consumers never branch on source/samples.
export const resolveSmartTaskLearning = (
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined,
): boolean => {
  if (!provenance) return false;
  if (provenance.source === 'bootstrap') return true;
  // Nothing to learn: an energy task's rate is exact.
  if (provenance.source === 'exact') return false;
  return provenance.acceptedSamples < MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP;
};

// Smart-task list confidence chip. Shown only during genuine cold-start
// (`learning`) and never on a settled task: `on_track` is silent (the steady
// case carries no useful signal and a forever-`low` thermal rate would nag),
// and `cannot_meet` already owns its row with the strongest state chip + body.
export const formatSmartTaskListConfidenceChipLabel = (
  confidence: ObjectiveProfileConfidence | null | undefined,
  statusId: SmartTaskListStatusId,
  learning: boolean,
): string | null => {
  if (statusId === 'cannot_meet' || statusId === 'on_track' || statusId === 'unavailable') return null;
  if (!learning) return null;
  return formatConfidenceChipLabel(confidence);
};

// ─── EV learning provenance rows ──────────────────────────────────────────────

// A row in the plan-inputs card describing one provenance fact (source, value,
// sample count, confidence, last accepted at). Pre-resolved at this layer so
// the view never branches on `source` / null values.
//
// `tone` is a producer-resolved affordance slug for the row's value cell. Null
// for neutral rows; `'warn'` signals an at-risk fact (e.g. the latest learned
// reading is older than 24 h). The view dispatches the slug to a CSS modifier
// (`.plan-inputs__row-value--warn`) so the value cell picks up a status colour
// instead of the row staying visually indistinguishable from healthy siblings.
// Per `feedback_layering_resolution_in_producer.md`, the staleness boolean
// stays in shared-domain — consumers never re-derive it from the value text.
//
// `freshnessOfMs` is set only on the "Latest reading used" row so the view can
// re-derive both `value` and `tone` on a 60s tick (without it the rendered
// "Updated 5 min ago" would freeze on the original render's `nowMs` until the
// next plan refresh, the freeze caught by the v2.8.0 adversarial review). The
// producer still emits a pre-formatted `value`/`tone` pair so non-React
// consumers (runtime breadcrumbs, the producer-side test) keep working
// unchanged. The view recomputes via `formatLastSampleValue` when this field
// is present — the tone can flip (`null` → `'warn'`) when a sample crosses
// the 24 h staleness threshold while the page is open.
export type KwhPerUnitProvenanceRowTone = 'warn';
export type KwhPerUnitProvenanceRow = {
  label: string;
  value: string;
  tone: KwhPerUnitProvenanceRowTone | null;
  freshnessOfMs?: number;
};

// Confidence text is rendered next to the learned mean. Lowercase to fit the
// neighbouring sentence ("12 readings · medium confidence"); the chip surface
// uses sentence-case copy elsewhere.
const CONFIDENCE_TEXT: Record<'low' | 'medium' | 'high', string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

const formatSamplesLine = (acceptedSamples: number, confidence: 'low' | 'medium' | 'high' | null): string => {
  const sampleWord = acceptedSamples === 1 ? 'reading' : 'readings';
  const base = `${acceptedSamples} accepted power ${sampleWord}`;
  return confidence === null ? base : `${base} · ${CONFIDENCE_TEXT[confidence]}`;
};

// Freshness window before a learned profile counts as stale. After this, the
// row shows "Stale — <timestamp>" so the user knows the value behind the chip
// is older than yesterday's reality.
const SAMPLE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

// Browser-side relative-time text for the most recent accepted sample. Stays
// in shared-domain so runtime breadcrumbs and the UI render the same phrasing
// (per `feedback_ui_text_shared_with_logs.md`). The caller supplies
// `formatAcceptedAt` only for the stale branch — runtime callers pass a
// timezone-aware Intl formatter; the UI passes a `toLocaleString` wrapper.
//
// Returns `{ text, tone }` where `tone` is `'warn'` when the latest accepted
// sample is older than the 24 h freshness window and `null` otherwise. The
// producer resolves the staleness signal once here so the UI consumer never
// re-derives it from the rendered text (per
// `feedback_layering_resolution_in_producer.md`).
//
// Exported so the settings UI can re-derive `{ text, tone }` on its 60s
// freshness tick (`PlanInputsCard` in `views/DeadlinePlan.tsx`) without
// re-running the whole row builder. Producer-side
// `resolveKwhPerUnitProvenanceRows` calls this once to seed `value`/`tone`;
// the view recomputes via the same helper so the phrasing never drifts
// between the initial render and the tick — and so the tone can flip from
// `null` to `'warn'` when a sample crosses the 24 h staleness threshold
// without a fresh producer pass.
export const formatLastSampleValue = (
  lastMs: number,
  nowMs: number,
  formatAcceptedAt: (ms: number) => string,
): { text: string; tone: KwhPerUnitProvenanceRowTone | null } => {
  const ageMs = Math.max(0, nowMs - lastMs);
  if (ageMs >= SAMPLE_STALE_THRESHOLD_MS) {
    return { text: `Stale — ${formatAcceptedAt(lastMs)}`, tone: 'warn' };
  }
  if (ageMs < ONE_MINUTE_MS) return { text: 'Updated just now', tone: null };
  if (ageMs < ONE_HOUR_MS) {
    const minutes = Math.max(1, Math.round(ageMs / ONE_MINUTE_MS));
    return { text: `Updated ${minutes} min ago`, tone: null };
  }
  const hours = Math.max(1, Math.round(ageMs / ONE_HOUR_MS));
  return { text: `Updated ${hours} ${pluralHour(hours)} ago`, tone: null };
};

// Resolve the smart-task chip's underlying confidence value from the plan's
// own provenance: the confidence the plan was built with, never the live
// profile's, so the hero, the deadlines list and the widget agree for one plan.
// Producer-side resolution lives here, not in the UI consumer, per
// `feedback_layering_resolution_in_producer.md`.
//
// Preference order:
//   1. `provenance.displayConfidence` — band-aware aggregate the recorder
//      writes today. Drives `Estimating` / `Refining` honestly because it
//      reflects the bands actually integrated, not raw per-sample CV.
//   2. `provenance.confidence` — band-aware once bands have fit (it mirrors
//      the live `kwhPerUnit.confidence`, which Step 2 of the Cause-#1 fix
//      re-resolves against the pooled within-band residual), falls back to
//      raw-CV when no bands exist. Kept on the provenance for log/diagnostic
//      parity; covers plans persisted after provenance shipped but before
//      `displayConfidence` shipped.
//   3. `null` — no signal (no provenance, or a bootstrap rate); the chip
//      suppresses.
//
// Returning a single flat value lets the UI consumer treat the result as
// opaque — it never sees `provenance` / `kind` / `source`.
export const resolveChipConfidence = (
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined,
): 'low' | 'medium' | 'high' | null => (
  provenance?.displayConfidence ?? provenance?.confidence ?? null
);

// Resolve display rows for the kWhPerUnit provenance snapshot. The caller
// supplies `formatAcceptedAt` because shared-domain stays free of locale and
// timezone helpers — the UI passes a browser-side formatter, while runtime
// callers can pass a timezone-aware `Intl.DateTimeFormat` formatter.
//
// Producer-side resolution: the UI just renders these rows; it never branches
// on `source`, raw kWh values, or null fields.
export const resolveKwhPerUnitProvenanceRows = (
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined,
  nowMs: number,
  formatAcceptedAt: (ms: number) => string,
): KwhPerUnitProvenanceRow[] => {
  if (!provenance) return [];
  if (provenance.source === 'bootstrap') {
    // Bootstrap rows describe the cold-start state. The plan-inputs row note
    // already says "Estimated — refining as PELS observes charging", so a
    // single Source row is enough here — adding "0 readings" would be noisy.
    return [{ label: 'Source', value: 'Starting estimate', tone: null }];
  }
  if (provenance.source === 'exact') {
    // An energy task: every kWh the device takes is a kWh of progress, counted
    // from its power readings. There are no samples or confidence to report.
    return [{ label: 'Source', value: 'Counted from power readings', tone: null }];
  }
  // `Learned from power readings` source no longer carries a redundant `Learned rate` row
  // (the card's headline already shows the rate value). Surface only the
  // facts the headline doesn't repeat: sample count + confidence, and the
  // recency of the latest reading used (recency is a separate signal from the
  // confidence chip — the chip is "how many / how tight," "Latest reading
  // used" is "how long since we saw fresh evidence").
  const rows: KwhPerUnitProvenanceRow[] = [
    { label: 'Source', value: 'Learned from power readings', tone: null },
  ];
  if (provenance.acceptedSamples > 0) {
    rows.push({
      label: 'Readings used',
      value: formatSamplesLine(provenance.acceptedSamples, provenance.confidence),
      tone: null,
    });
  }
  if (provenance.lastAcceptedAtMs !== null && Number.isFinite(provenance.lastAcceptedAtMs)) {
    const lastSample = formatLastSampleValue(
      provenance.lastAcceptedAtMs,
      nowMs,
      formatAcceptedAt,
    );
    rows.push({
      label: 'Latest reading used',
      value: lastSample.text,
      tone: lastSample.tone,
      // Carrying the raw timestamp lets the React view re-derive `value` and
      // `tone` every 60s without freezing on the initial `nowMs` for the whole
      // session. Non-React consumers ignore this field and read `value`/`tone`.
      freshnessOfMs: provenance.lastAcceptedAtMs,
    });
  }
  return rows;
};
