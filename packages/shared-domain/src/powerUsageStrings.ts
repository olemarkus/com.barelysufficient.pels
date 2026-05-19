// Canonical wording for the Power-tab empty states and hourly heatmap cell
// totals. Lives in shared-domain so the settings UI and any future runtime log
// line emit identical text (Rule 4 — UI text shared with logs,
// `notes/ui-terminology.md`).
//
// The Power tab surfaces two distinct empty states:
//   - The selected week has no buckets — but other weeks do (navigation issue).
//   - PELS has never received any power sample (setup issue).
// The latter copy steers users at the missing Flow action without exposing
// internal terminology like "bucket" or "sample".

export const formatPowerUsageEmptyForWeek = (): string => (
  'No hourly usage for the selected week.'
);

export const formatPowerUsageEmptyAwaitingSamples = (): string => (
  'Set up the Report power usage Flow action to start recording.'
);

// Hourly heatmap cell tooltips reuse this helper. Cells aggregate multiple
// physical hours when a DST fall-back collapses two wall-clock 02:00 readings
// (or when sample arrival is irregular), so the suffix tells the user the
// number is a sum rather than a single hour's reading. Single-bucket cells
// drop the "total" qualifier to keep the common case terse.
export const formatPowerUsageHourlyTotal = (
  kWh: number,
  options: { aggregated: boolean },
): string => {
  const formatted = kWh.toFixed(2);
  return options.aggregated ? `${formatted} kWh total` : `${formatted} kWh`;
};
