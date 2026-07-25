// Simulation-mode reason-line mood.
//
// In simulation mode PELS never actually switches or limits a device — it only
// shows what it WOULD do. A held/limited device's state line already reads
// hypothetically ("Would be turned off (simulation)"); this makes the reason
// line beneath it agree in mood so the card never asserts an action that never
// happened (notes/overview-hero-spec.md § "Simulation mode is hypothetical").
//
// Scope — ONLY would-be-acted (held/limited) reasons become hypothetical. Every
// "Limited …" reason (hard cap, daily/hourly budget, swap, budget starvation) is
// a PELS-limiting claim, so it flips to "Would be limited …". Two non-"Limited"
// acted phrases (making room for a higher-priority device, deferring to cheaper
// hours) have explicit overrides. Everything else passes through unchanged —
// idle/resuming states, waiting-to-resume, the physical "Waiting for available
// power" (true in simulation or not), surplus boosts, and normal operation are
// correctly factual and MUST stay factual.

// Swap-pending copy has a bare and a named-target variant ("Making room for
// higher-priority device" / "… (Bedroom)"); the prefix rewrite carries any
// trailing "(name)" through so both flip.
const MAKING_ROOM_PREFIX = 'Making room for higher-priority device';

// The `(simulation)` tag every converted (hypothetical) line carries. With the
// 2026-07 card grammar the state word stays factual under simulation, so the
// reason line is the ONLY per-card carrier of the hypothetical framing — the
// tag keeps a card scrolled away from the banner honest on its own (the same
// rule the `DEVICE_OVERVIEW_WOULD_*` action labels already follow).
import { PLAN_STATE_HELD_FALLBACK_STATUS } from './planStateLabels';

const SIMULATION_TAG = ' (simulation)';

export const toSimulationReasonLine = (label: string, dryRun: boolean): string => {
  if (!dryRun || label.length === 0) return label;
  // "Limited …" → "Would be limited … (simulation)" (lowercase the leading L,
  // prepend the hypothetical mood). Covers every "Limited …" reason — hard
  // cap, daily/hourly budget, budget starvation, stepped "Limited to X", and
  // the named/bare "Limited so <device> can run" swap — without enumerating
  // the exact tails.
  if (label.startsWith('Limited')) {
    return `Would be ${label.charAt(0).toLowerCase()}${label.slice(1)}${SIMULATION_TAG}`;
  }
  if (label.startsWith(MAKING_ROOM_PREFIX)) {
    return `Would make room for a higher-priority device${label.slice(MAKING_ROOM_PREFIX.length)}${SIMULATION_TAG}`;
  }
  if (label === 'Waiting for cheaper hours') return `Would wait for cheaper hours${SIMULATION_TAG}`;
  // The held fallback (`PLAN_STATE_HELD_FALLBACK_STATUS`). It is not a "Limited …"
  // line, but it IS a PELS-acted hold — the device is only waiting because PELS is
  // holding it — so in simulation it must read hypothetically and carry the tag,
  // or a card scrolled away from the banner reads as a factual hold PELS is not
  // performing.
  if (label === PLAN_STATE_HELD_FALLBACK_STATUS) return `Would be held back${SIMULATION_TAG}`;
  return label;
};
