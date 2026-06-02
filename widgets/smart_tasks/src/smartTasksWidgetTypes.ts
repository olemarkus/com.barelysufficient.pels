import type { DeferredPlanHistoryChartData } from '../../../packages/shared-domain/src/deferredPlanHistoryChartData';

export type SmartTasksWidgetTone = 'danger' | 'warn' | 'muted' | 'ok';

export type SmartTasksWidgetRow = {
  deviceId: string;
  deviceName: string;
  kind: 'temperature' | 'ev_soc';
  unitSymbol: '°C' | '%';
  currentValue: number | null;
  targetValue: number;
  // Pre-formatted "HH:MM" local-time finish line, or null when no ETA / deadline
  // is available (only happens for some edge pending states).
  finishLabel: string | null;
  statusLabel: string;
  tone: SmartTasksWidgetTone;
  // Producer-resolved word sources (from shared-domain) so the renderer never
  // hardcodes user-facing copy. `etaVerb` is "Due" on failing tasks, else
  // "Ready by"; `targetActionVerb` is "Heat to" / "Charge to"; `targetNoun` is
  // "Target" for the no-current-reading values line.
  etaVerb: string;
  targetActionVerb: string;
  targetNoun: string;
  // Pre-formatted long deadline label (e.g. "Sat 16:00", "Today 16:00") used
  // by the interactive detail panel. Falls back to `finishLabel` semantics
  // when no deadline timestamp is on the plan — null in that edge case.
  deadlineLongLabel: string | null;
  // "≈3h 12m at 2.4 kW · ≈7.8 kWh" or range form "≈7.0–8.0 kWh". Null when
  // the planner hasn't produced a revision yet, when there's no rate, or when
  // duration/speed metrics are missing.
  planMetaLabel: string | null;
  // Confidence chip label ("Estimating" / "Refining") for cold-start tasks,
  // null when the task is settled / on_track / cannot_meet.
  confidenceLabel: string | null;
  // One-line "why now" sentence, composed by shared-domain. Null on `on_track`
  // and `satisfied` (chip is the answer).
  whyLabel: string | null;
  // Closing-sentence recourse hint shown under whyLabel on cannot_meet and
  // EV-unplugged cases. Null when the widget can't honestly offer recourse.
  recourseHint: string | null;
  // Producer-resolved planned-vs-actual trajectory for the tap-to-detail chart
  // (planned staircase + observed progress line + target). `null` when there's
  // nothing chartable yet (no rate AND < 2 observed samples) — the detail panel
  // hides the chart and shows only the text lines. Resolved by
  // `resolveActivePlanChartData` in shared-domain.
  chart: DeferredPlanHistoryChartData | null;
};

// A task that finalized within the recent window (last 24h), shown in the
// "Recently ended" section below the active rows. Carries its FINAL trajectory
// (resolved from the persisted history entry) so tapping it shows the same
// chart shape as an on-going task. The outcome label + tone come from the
// shared-domain history helpers so the widget never hardcodes "Succeeded" /
// "Missed" copy (`feedback_ui_text_shared_with_logs`).
export type SmartTasksWidgetEndedRow = {
  // Stable history-entry id (NOT deviceId) — a device can finalize more than one
  // task within the 24h window, so the tap target / detail lookup must key on
  // this unique id to open the run the user actually tapped.
  id: string;
  deviceId: string;
  deviceName: string;
  unitSymbol: '°C' | '%';
  targetValue: number;
  // "Heat to 55 °C" / "Charge to 80 %" — producer-resolved action verb.
  targetActionVerb: string;
  // Outcome chip label ("Succeeded" / "Missed" / "Abandoned" / "Unknown").
  outcomeLabel: string;
  outcomeTone: SmartTasksWidgetTone;
  // Long local-time label for when the run ended ("Today 14:20", "Sat 14:20").
  finishedLabel: string;
  chart: DeferredPlanHistoryChartData | null;
};

export type SmartTasksWidgetReadyPayload = {
  state: 'ready';
  rows: SmartTasksWidgetRow[];
  // Number of active (non-satisfied) tasks not included in the top-3.
  overflowCount: number;
  // Tasks that finalized in the recent window, newest first, capped. Empty when
  // nothing ended recently. The payload is `ready` (not `empty`) whenever EITHER
  // `rows` or `endedRows` is non-empty.
  endedRows: SmartTasksWidgetEndedRow[];
};

export type SmartTasksWidgetEmptyPayload = {
  state: 'empty';
  subtitle: string;
  // Optional second-line pointer (e.g. "Add a smart task from a Flow card to
  // see it here."). Renders muted under the subtitle. Null when the empty
  // state is "no current tasks" rather than "never any tasks".
  hint: string | null;
};

export type SmartTasksWidgetPayload = SmartTasksWidgetReadyPayload | SmartTasksWidgetEmptyPayload;
