import { render } from 'preact';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { SMART_TASK_PAST_EMPTY_COPY } from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatMissStreakAggregateLine } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import {
  filterPlanHistoryByDevice,
  formatSmartTaskHistoryDeviceFilterEmpty,
  resolveSmartTaskHistoryFilterDevices,
  SMART_TASK_HISTORY_FILTER_ALL_LABEL,
  SMART_TASK_HISTORY_FILTER_GROUP_LABEL,
  type SmartTaskHistoryFilterDevice,
} from '../../../../shared-domain/src/deferredPlanHistoryDeviceFilter.ts';
import {
  groupPlanHistoryByIsoWeek,
  resolvePlanHistory7DayHitRateStrip,
} from '../../../../shared-domain/src/deferredPlanHistoryReceipt.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { PlanHistoryCard } from './DeadlinePlanHistory.tsx';

export type DeadlinesHistoryListState =
  | { status: 'loading' }
  // `hidden` is kept for callers that explicitly want to suppress the whole
  // section (e.g. transitional renders). `empty` is the user-facing zero-state
  // — same heading shape as `ready`, but a copy line instead of cards.
  | { status: 'hidden' }
  | { status: 'empty' }
  | {
      status: 'ready';
      entries: DeferredObjectivePlanHistoryEntry[];
      timeZone: string;
      // Cost unit suffix for the weekly section roll-ups (e.g. `kr`). An
      // empty string or omitted prop drops the cost half of the heading;
      // the section break still renders. v2.7.3.
      costUnit?: string;
      // Wall-clock anchor for the relative week-divider phrasing ("This
      // week" / "Last week" / "Week of 12 May"). Optional so legacy callers
      // and tests can default to `Date.now()` — the production renderer
      // threads it explicitly so the section copy is snapshot-stable.
      nowMs?: number;
      // Active device filter id, or `null` for the default "All" view. The
      // owning controller (`deadlinesList.ts`) persists this in localStorage
      // and forwards it on every render — the view stays a pure projection.
      selectedDeviceId?: string | null;
      // Click handler for a chip. The controller is responsible for updating
      // `selectedDeviceId` and re-rendering. `null` means "All".
      onSelectDevice?: (deviceId: string | null) => void;
    };

type MissStreakBadge = { deviceId: string; deviceName: string; line: string };

// Resolves per-device miss-streak badges for the past-tasks subhead. Iterates
// the entries in their existing newest-first order so the first instance of
// each device is the one used to drive the streak window; subsequent entries
// for the same device are skipped to avoid duplicate badges. Per
// `notes/smart-task-ui/README.md`, the badge surfaces the recovering-from-
// mistake user's "pattern at a glance" signal without forcing them to mentally
// aggregate the chip column.
const resolveMissStreakBadges = (
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
): MissStreakBadge[] => {
  const seenDevices = new Set<string>();
  const badges: MissStreakBadge[] = [];
  for (const entry of entries) {
    if (seenDevices.has(entry.deviceId)) continue;
    seenDevices.add(entry.deviceId);
    const line = formatMissStreakAggregateLine(entries, entry.deviceId);
    if (line === null) continue;
    badges.push({
      deviceId: entry.deviceId,
      deviceName: entry.deviceName ?? entry.deviceId,
      line,
    });
  }
  return badges;
};

// Chip row above the weekly archive. Hidden when the unfiltered list contains
// fewer than two devices — filtering by the only device that has history is a
// no-op and adds visual noise. Each chip is a `<button>` with `aria-pressed`
// so screen readers announce the selection state; the `--link` chip variant
// already enforces the 48 dp tap target (see `.plan-chip--link` in
// `public/style.css`).
const DeviceFilterChipRow = ({
  devices,
  selectedDeviceId,
  onSelectDevice,
}: {
  devices: ReadonlyArray<SmartTaskHistoryFilterDevice>;
  selectedDeviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
}) => {
  if (devices.length < 2) return null;
  // Treat a stale persisted filter (pointing at a device no longer in history)
  // as the "All" selection so the chip-row state matches what the list
  // actually renders. Without this, the row would render with no chip pressed
  // — confusing both screen readers and sighted users.
  const knownSelected = devices.some((device) => device.deviceId === selectedDeviceId);
  const allActive = selectedDeviceId === null || !knownSelected;
  return (
    <div
      class="deadlines-history__filter-row"
      role="group"
      aria-label={SMART_TASK_HISTORY_FILTER_GROUP_LABEL}
    >
      <button
        type="button"
        class={`plan-chip plan-chip--link${allActive ? ' plan-chip--info' : ''}`}
        aria-pressed={allActive}
        onClick={() => onSelectDevice(null)}
      >
        {SMART_TASK_HISTORY_FILTER_ALL_LABEL}
      </button>
      {devices.map((device) => {
        const active = device.deviceId === selectedDeviceId;
        return (
          <button
            key={device.deviceId}
            type="button"
            class={`plan-chip plan-chip--link${active ? ' plan-chip--info' : ''}`}
            aria-pressed={active}
            // Tapping the active chip clears the filter; tapping an inactive
            // chip switches to that device. Matches the spec's "tap selected
            // chip again to return to All" affordance.
            onClick={() => onSelectDevice(active ? null : device.deviceId)}
          >
            {formatDisplayDeviceName(device.deviceName)}
          </button>
        );
      })}
    </div>
  );
};

export const DeadlinesHistoryListRoot = ({ state }: { state: DeadlinesHistoryListState }) => {
  if (state.status === 'hidden') return null;
  if (state.status === 'loading') {
    return (
      <section
        class="deadlines-history"
        aria-labelledby="deadlines-history-title"
        aria-busy="true"
      >
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <div class="pels-skeleton-stack" aria-hidden="true">
          <span class="pels-skeleton pels-skeleton--card"></span>
          <span class="pels-skeleton pels-skeleton--card"></span>
        </div>
        <span class="visually-hidden">Loading past tasks…</span>
      </section>
    );
  }
  if (state.status === 'empty') {
    return (
      <section class="deadlines-history" aria-labelledby="deadlines-history-title">
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <p class="muted">{SMART_TASK_PAST_EMPTY_COPY}</p>
      </section>
    );
  }
  // Badges + chip row both derive from the *unfiltered* entry list so the
  // chip row stays stable while the user toggles the filter, and so a
  // miss-streak badge for a non-selected device still surfaces if any.
  const badges = resolveMissStreakBadges(state.entries);
  // 7-day hit-rate strip — first-impression aggregate for the recovering-
  // from-mistake persona ("how have my deadlines been doing this week?").
  // Threaded with the same `nowMs` anchor as the week dividers so the strip
  // is snapshot-stable. Resolved from the *unfiltered* entry list so the
  // strip stays stable while the user toggles the device filter — toggling
  // the chips should narrow the per-row list, not redefine "the week".
  const hitRateStrip = resolvePlanHistory7DayHitRateStrip(
    state.entries,
    state.nowMs ?? Date.now(),
    state.timeZone,
  );
  const devices = resolveSmartTaskHistoryFilterDevices(state.entries);
  const selectedDeviceId = state.selectedDeviceId ?? null;
  const onSelectDevice = state.onSelectDevice ?? (() => {});
  // Filter the entries that will be rendered. `filterPlanHistoryByDevice`
  // collapses a stale filter (device id no longer in history) back to the
  // unfiltered list, which the chip-row removal handles on the same render.
  const filteredEntries = filterPlanHistoryByDevice(state.entries, selectedDeviceId);
  // Resolve the active-filter empty-state copy from the selected chip's
  // display name. We render this when the filter matched zero rows even
  // though the unfiltered list is non-empty — `filterPlanHistoryByDevice`
  // self-heals stale filters by returning the unfiltered list, so this
  // branch should not fire in practice, but the empty surface still keeps
  // the user oriented if filter shape ever changes.
  const selectedDevice = selectedDeviceId === null
    ? null
    : devices.find((device) => device.deviceId === selectedDeviceId) ?? null;
  // v2.7.3 — ISO-week section breaks. Producer-resolved grouping + heading copy
  // so the view layer never inspects per-week aggregates. The weekly stripe is
  // the emotional anchor for the archive shape; per-row content stays exactly
  // as the existing `PlanHistoryCard` renders it.
  const weekGroups = groupPlanHistoryByIsoWeek(
    filteredEntries,
    state.timeZone,
    state.costUnit ?? '',
    state.nowMs ?? Date.now(),
  );
  return (
    <section class="deadlines-history" aria-labelledby="deadlines-history-title">
      <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
      {badges.length > 0 && (
        <ul class="deadlines-history__miss-streaks" aria-label="Miss streaks">
          {badges.map((badge) => (
            <li key={badge.deviceId} class="deadlines-history__miss-streak">
              <span class="deadlines-history__miss-streak-device">{formatDisplayDeviceName(badge.deviceName)}</span>
              {' — '}
              <span class="deadlines-history__miss-streak-count">{badge.line}</span>
            </li>
          ))}
        </ul>
      )}
      {hitRateStrip !== null && (
        <p class="deadlines-history__summary-strip">{hitRateStrip.text}</p>
      )}
      <DeviceFilterChipRow
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={onSelectDevice}
      />
      {weekGroups.length === 0 && selectedDevice !== null && (
        <p class="muted">{formatSmartTaskHistoryDeviceFilterEmpty(selectedDevice.deviceName)}</p>
      )}
      {weekGroups.map((group) => (
        <div key={group.weekKey} class="deadlines-history__week-group">
          <h4 class="deadlines-history__week">{group.heading}</h4>
          <div class="plan-history-list">
            {group.entries.map((entry) => (
              <PlanHistoryCard
                key={entry.id}
                entry={entry}
                timeZone={state.timeZone}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
};

export const renderDeadlinesHistoryList = (
  surface: HTMLElement,
  state: DeadlinesHistoryListState,
): void => {
  render(<DeadlinesHistoryListRoot state={state} />, surface);
};
