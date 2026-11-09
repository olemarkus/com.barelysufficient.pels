import type { MainFuse } from '../../../contracts/src/capacitySettings.ts';
import { gridImportTargetKw } from '../../../shared-domain/src/settings/powerLimits.ts';
import {
  isMainFuseSupply,
  isValidMainFuseAmps,
  mainFusePhaseTargetKw,
  mainFuseTotalKw,
} from '../../../shared-domain/src/settings/mainFuse.ts';
import {
  settingsMainFuseAmpsInput,
  settingsMainFuseEnabledInput,
  settingsMainFuseFields,
  settingsMainFuseHint,
  settingsMainFuseSupplySelect,
} from './dom.ts';

import { bindMainFusePhaseSource, syncMainFusePhaseSource } from './mainFusePhaseSource.ts';

const FUSE_SIZE_PROMPT = 'Use the number on your connection, like the 25 in 3x25 A or the 35 in 1x35 A.';
const FUSE_SIZE_ERROR = 'Enter a size from 6 to 250 A.';

let phasesPowerOnly = false;

const readFormFuse = (): MainFuse | null => {
  if (settingsMainFuseEnabledInput?.selected !== true) return { kind: 'off' };
  const supply = settingsMainFuseSupplySelect?.value;
  const amps = Number.parseFloat(settingsMainFuseAmpsInput?.value ?? '');
  return isMainFuseSupply(supply) && isValidMainFuseAmps(amps) ? { kind: 'on', supply, amps } : null;
};

const hasInvalidSize = (): boolean => {
  const raw = settingsMainFuseAmpsInput?.value ?? '';
  return settingsMainFuseEnabledInput?.selected === true && raw !== '' && !isValidMainFuseAmps(Number.parseFloat(raw));
};

const formatFuseHint = (fuse: Extract<MainFuse, { kind: 'on' }>): string => {
  const totalKw = gridImportTargetKw(mainFuseTotalKw(fuse)).toFixed(1);
  if (fuse.supply !== 'three_phase_neutral') return `PELS starts reducing loads near ${totalKw} kW.`;
  const phaseKw = mainFusePhaseTargetKw(fuse.amps, !phasesPowerOnly).toFixed(1);
  return `PELS starts reducing loads near ${phaseKw} kW per phase (${totalKw} kW in total).`;
};

const renderFuseSizeFeedback = (): void => {
  const invalid = hasInvalidSize();
  settingsMainFuseAmpsInput?.toggleAttribute('error', invalid);
  settingsMainFuseAmpsInput?.setAttribute('error-text', invalid ? FUSE_SIZE_ERROR : '');
  if (!settingsMainFuseHint) return;
  const fuse = readFormFuse();
  settingsMainFuseHint.hidden = invalid;
  settingsMainFuseHint.textContent = fuse === null || fuse.kind === 'off' ? FUSE_SIZE_PROMPT : formatFuseHint(fuse);
};

export const refreshMainFuseControls = (): void => {
  if (settingsMainFuseFields) settingsMainFuseFields.hidden = settingsMainFuseEnabledInput?.selected !== true;
  const supply = settingsMainFuseEnabledInput?.selected === true ? settingsMainFuseSupplySelect?.value : undefined;
  void syncMainFusePhaseSource(supply, (powerOnly) => {
    phasesPowerOnly = powerOnly;
    renderFuseSizeFeedback();
  });
  renderFuseSizeFeedback();
};

/** Saved like the other limits: the moment the form holds a fuse PELS can use. */
export const bindMainFuseControls = (autoSave: () => Promise<void>): void => {
  bindMainFusePhaseSource();
  const refreshAndSave = (): void => {
    refreshMainFuseControls();
    if (readFormFuse() === null) {
      settingsMainFuseAmpsInput?.focus();
      return;
    }
    void autoSave();
  };
  settingsMainFuseEnabledInput?.addEventListener('change', refreshAndSave);
  settingsMainFuseSupplySelect?.addEventListener('change', refreshAndSave);
  settingsMainFuseAmpsInput?.addEventListener('input', refreshMainFuseControls);
  settingsMainFuseAmpsInput?.addEventListener('change', refreshAndSave);
};

export const syncMainFuseControls = (fuse: MainFuse, storedAmps: unknown): void => {
  if (settingsMainFuseEnabledInput) settingsMainFuseEnabledInput.selected = fuse.kind === 'on';
  // Kept while off, so turning the fuse back on needs no retyping.
  if (fuse.kind === 'off' && isValidMainFuseAmps(storedAmps) && settingsMainFuseAmpsInput) {
    settingsMainFuseAmpsInput.value = String(storedAmps);
  }
  if (fuse.kind === 'on') {
    if (settingsMainFuseSupplySelect) settingsMainFuseSupplySelect.value = fuse.supply;
    if (settingsMainFuseAmpsInput) settingsMainFuseAmpsInput.value = String(fuse.amps);
  }
  refreshMainFuseControls();
};

/** The form's fuse, for a save. An enabled switch needs a valid size. */
export const readMainFuseForm = (): MainFuse => {
  const fuse = readFormFuse();
  if (fuse === null) throw new Error('Main fuse size must be between 6 and 250 A.');
  return fuse;
};
