import type { CapacityScalarSettings, MainFuse } from '../../../contracts/src/capacitySettings.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';
import { mainFuseTotalKw } from '../../../shared-domain/src/settings/mainFuse.ts';
import { gridImportTargetKw } from '../../../shared-domain/src/settings/powerLimits.ts';
import { getHomeyTimezone } from './homey.ts';
import {
  NO_USAGE_EVIDENCE,
  checkHardCap,
  checkInstantLimit,
  formatHardCapFinding,
  formatInstantLimitFinding,
  resolveLimitUsageEvidence,
  type LimitUsageEvidence,
} from './limitUsageGuard.ts';
import { peekMainFuseForm, readSavedMainFuse, restoreSavedMainFuseForm } from './mainFuseControls.ts';
import { readPowerLimitFormView, syncCapacityLimitControls } from './powerLimitControls.ts';

/**
 * Warns, beside each limit on Limits & safety, when the home's own usage is
 * already above it, and asks before a lowered limit like that is saved.
 */

type ConfirmDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };

const gridAlert = document.getElementById('settings-grid-import-usage-alert');
const fuseAlert = document.getElementById('settings-main-fuse-usage-alert');
const hardCapAlert = document.getElementById('settings-capacity-limit-usage-alert');
const dialog = document.querySelector<ConfirmDialog>('#limits-usage-confirm-dialog');
const dialogFindings = document.getElementById('limits-usage-confirm-findings');

let evidence: LimitUsageEvidence = NO_USAGE_EVIDENCE;

const fuseTargetKw = (fuse: MainFuse | null): number | null => (
  fuse?.kind === 'on' ? gridImportTargetKw(mainFuseTotalKw(fuse)) : null
);

const describeInstant = (targetKw: number | null): string | null => {
  const finding = targetKw === null ? null : checkInstantLimit(targetKw, evidence);
  return finding ? formatInstantLimitFinding(finding, Date.now(), getHomeyTimezone()) : null;
};

const describeHardCap = (limitKw: number | null, marginKw: number | null): string | null => {
  if (limitKw === null || marginKw === null) return null;
  const finding = checkHardCap(limitKw - marginKw, evidence);
  return finding ? formatHardCapFinding(finding) : null;
};

const renderAlert = (element: HTMLElement | null, message: string | null): void => {
  element?.replaceChildren(message ?? '');
  element?.toggleAttribute('hidden', message === null);
};

/** Redraw the three warnings from what the form shows now, saved or not. */
export const refreshLimitUsageAlerts = (): void => {
  const view = readPowerLimitFormView();
  const gridTarget = view?.gridImportEnabled && view.gridImportLimitKw !== null
    ? gridImportTargetKw(view.gridImportLimitKw)
    : null;
  renderAlert(gridAlert, describeInstant(gridTarget));
  renderAlert(fuseAlert, describeInstant(fuseTargetKw(peekMainFuseForm())));
  renderAlert(hardCapAlert, view?.capacityEnabled ? describeHardCap(view.limitKw, view.marginKw) : null);
};

/** The power read Limits & safety loaded (`null`: it failed, so no warning); warnings follow it. */
export const publishLimitUsagePower = (payload: SettingsUiPowerPayload | null): void => {
  evidence = payload ? resolveLimitUsageEvidence(payload, Date.now()) : NO_USAGE_EVIDENCE;
  refreshLimitUsageAlerts();
};

// Any edit in the form can move a warning; read it after the field's own handlers ran.
const refreshAfterEdit = (): void => queueMicrotask(refreshLimitUsageAlerts);
document.getElementById('settings-limits-form')?.addEventListener('input', refreshAfterEdit, true);
document.getElementById('settings-limits-form')?.addEventListener('change', refreshAfterEdit, true);

export type LimitsToSave = Pick<
  CapacityScalarSettings,
  'capacityEnabled' | 'gridImportLimitKw' | 'limitKw' | 'marginKw'
>;

// Only a limit the owner lowered (or turned on) asks: re-saving a value already
// in force, or one an unrelated field carried along, never does.
const loweredFindings = (
  next: LimitsToSave,
  nextFuse: MainFuse,
  stored: LimitsToSave,
  storedFuse: MainFuse,
): string[] => {
  const findings: Array<string | null> = [];
  const nextGrid = next.gridImportLimitKw;
  if (nextGrid !== null && (stored.gridImportLimitKw === null || nextGrid < stored.gridImportLimitKw)) {
    findings.push(describeInstant(gridImportTargetKw(nextGrid)));
  }
  const nextFuseKw = fuseTargetKw(nextFuse);
  const storedFuseKw = fuseTargetKw(storedFuse);
  if (nextFuseKw !== null && (storedFuseKw === null || nextFuseKw < storedFuseKw)) {
    findings.push(describeInstant(nextFuseKw));
  }
  const storedTarget = stored.capacityEnabled ? stored.limitKw - stored.marginKw : null;
  if (next.capacityEnabled && (storedTarget === null || next.limitKw - next.marginKw < storedTarget)) {
    findings.push(describeHardCap(next.limitKw, next.marginKw));
  }
  return findings.filter((finding): finding is string => finding !== null);
};

/**
 * `save` when the save may go ahead: nothing lowered is below the home's usage,
 * or the owner chose to save anyway. `cancel` when the owner kept the saved
 * limits. `pending` for a save made while the question is open: it is dropped,
 * and the open question decides.
 */
export type LimitUsageDecision = 'save' | 'cancel' | 'pending';

export const confirmLimitsAgainstUsage = async (
  next: LimitsToSave,
  nextFuse: MainFuse,
  stored: LimitsToSave,
  storedFuse: MainFuse,
): Promise<LimitUsageDecision> => {
  const findings = loweredFindings(next, nextFuse, stored, storedFuse);
  if (findings.length === 0 || !dialog || !dialogFindings) return 'save';
  if (dialog.open) return 'pending';
  dialogFindings.replaceChildren(...findings.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  const current = dialog;
  current.returnValue = '';
  return new Promise<LimitUsageDecision>((resolve) => {
    current.addEventListener('close', () => resolve(current.returnValue === 'confirm' ? 'save' : 'cancel'), {
      once: true,
    });
    current.show();
  });
};

/**
 * Whether a limits save may go ahead. Kept saved limits put the form back to
 * them; a save made while the question is open is dropped.
 */
export const allowLimitsSave = async (
  next: LimitsToSave & { mainFuse: MainFuse },
  stored: CapacityScalarSettings,
): Promise<boolean> => {
  const decision = await confirmLimitsAgainstUsage(next, next.mainFuse, stored, readSavedMainFuse());
  if (decision === 'cancel') {
    syncCapacityLimitControls(stored);
    restoreSavedMainFuseForm();
    refreshLimitUsageAlerts();
  }
  return decision === 'save';
};
