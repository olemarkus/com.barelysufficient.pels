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
};

export type SmartTasksWidgetReadyPayload = {
  state: 'ready';
  rows: SmartTasksWidgetRow[];
  // Number of active (non-satisfied) tasks not included in the top-3.
  overflowCount: number;
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
