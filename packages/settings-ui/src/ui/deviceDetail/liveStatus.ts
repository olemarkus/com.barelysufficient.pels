// Device-detail hero (2026-07 coherence train PR-5; onto the `.pels-hero`
// primitive 2026-08): the first block under the app bar shows the SAME
// producer-resolved state word + current draw the Overview card renders, so
// the page answers "is PELS seeing this device right now?" before the ~20
// controls below.
//
// Data source: the plan-snapshot device from the `/ui_plan` API cache (primed
// on every realtime plan push). Its backend-resolved status supplies the same
// state, power, fact, and reason text as the Overview card. Hidden when the plan
// carries no entry for the device (e.g. an unmanaged device opened from the
// Devices list) — no fabricated status.
import {
  SETTINGS_UI_PLAN_PATH,
  type SettingsUiPlanPayload,
} from '../../../../contracts/src/settingsUiApi.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import { getApiReadModel } from '../homey.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { parsePlanSnapshot } from '../planSnapshotParse.ts';
import { hasActiveDeadlineObjective } from '../state.ts';
import type { PlanDeviceSnapshot } from '../planTypes.ts';

const getRow = (): {
  row: HTMLElement;
  stateEl: HTMLElement;
  powerEl: HTMLElement;
  factEl: HTMLElement | null;
  reasonEl: HTMLElement;
  smartTaskEl: HTMLAnchorElement | null;
  chipRowEl: HTMLElement | null;
} | null => {
  const row = document.getElementById('device-detail-live-status');
  const stateEl = document.getElementById('device-detail-live-state');
  const powerEl = document.getElementById('device-detail-live-power');
  const reasonEl = document.getElementById('device-detail-live-reason');
  if (!row || !stateEl || !powerEl || !reasonEl) return null;
  return {
    row,
    stateEl,
    powerEl,
    factEl: document.getElementById('device-detail-live-fact'),
    reasonEl,
    smartTaskEl: document.getElementById('device-detail-live-smart-task') as HTMLAnchorElement | null,
    chipRowEl: document.getElementById('device-detail-live-chip-row'),
  };
};

// Overlapping renders are last-wins: a slow plan read must not overwrite the
// row after the overlay switched device (or a fresher plan landed).
let renderSequence = 0;
export const renderDeviceDetailLiveStatus = async (deviceId: string): Promise<void> => {
  const mounts = getRow();
  if (!mounts) return;
  renderSequence += 1;
  const sequence = renderSequence;
  let dev: PlanDeviceSnapshot | undefined;
  let plan: { devices?: PlanDeviceSnapshot[]; generatedAtMs?: number } | null | undefined;
  try {
    const payload = await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH);
    // Cold API reads pass through the same required-status boundary as realtime
    // pushes before any presentation reaches the renderer.
    plan = parsePlanSnapshot(payload?.plan);
    dev = plan?.devices?.find((candidate) => candidate.id === deviceId);
  } catch {
    dev = undefined;
  }
  if (sequence !== renderSequence) return;
  if (!dev) {
    mounts.row.hidden = true;
    return;
  }
  // Interpolate the same server-owned countdown as the Overview. Expiry changes
  // only its text; the next backend status supplies any state transition.
  const nowMs = Date.now();
  dev = resolveDisplayPlanDeviceSnapshot(
    plan ?? null,
    dev,
    nowMs,
    nowMs,
  );
  renderHeroRows({ mounts, dev, deviceId, nowMs });
};

const renderHeroRows = (params: {
  mounts: NonNullable<ReturnType<typeof getRow>>;
  dev: PlanDeviceSnapshot;
  deviceId: string;
  nowMs: number;
}): void => {
  const { mounts, dev } = params;
  mounts.stateEl.textContent = dev.status.label;
  mounts.row.dataset.stateKind = dev.status.kind;
  mounts.powerEl.textContent = dev.status.powerText ?? '';
  if (mounts.factEl) {
    const factText = dev.status.factText ?? '';
    mounts.factEl.textContent = factText;
    mounts.factEl.hidden = factText === '';
  }
  const reasonText = dev.status.reason?.text ?? '';
  mounts.reasonEl.textContent = reasonText;
  mounts.reasonEl.hidden = reasonText === '';
  if (mounts.smartTaskEl) {
    const hasTask = hasActiveDeadlineObjective(params.deviceId, params.nowMs);
    mounts.smartTaskEl.hidden = !hasTask;
    // The chip rail collapses with its only chip: an empty visible rail
    // would still occupy a hero grid row and double the gap above the
    // headline.
    if (mounts.chipRowEl) mounts.chipRowEl.hidden = !hasTask;
    if (hasTask) mounts.smartTaskEl.href = buildDeadlineHref(params.deviceId);
  }
  mounts.row.hidden = false;
};

export const hideDeviceDetailLiveStatus = (): void => {
  renderSequence += 1;
  const mounts = getRow();
  if (mounts) mounts.row.hidden = true;
};
