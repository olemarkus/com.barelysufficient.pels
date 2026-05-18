// Plain-prose voice for the Usage hero "typical day" line. Lives in
// shared-domain so runtime structured logs can emit the same wording the user
// reads in the hero (see CLAUDE.md feedback `ui_text_shared_with_logs`).
//
// The legacy "Typical weekday: 14.2 kWh" form read like a stat row; the
// day-aware form names the actual day-of-week so the comparison feels
// personal — the same number, framed as story rather than table.

const DAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const formatTypicalDayLine = (
  weekdayIndex: number,
  typicalDayKWh: number,
): string => {
  const dayName = DAY_NAMES[weekdayIndex] ?? 'day';
  const kwh = Number.isFinite(typicalDayKWh) ? typicalDayKWh.toFixed(1) : '--';
  return `Your typical ${dayName} runs ${kwh} kWh.`;
};
