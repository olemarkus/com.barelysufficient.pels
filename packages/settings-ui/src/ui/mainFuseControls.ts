import type { MainFuse } from '../../../contracts/src/capacitySettings.ts';
import { gridImportTargetKw } from '../../../shared-domain/src/settings/powerLimits.ts';
import {
  isMainFuseSupply,
  isValidMainFuseAmps,
  mainFuseTotalKw,
} from '../../../shared-domain/src/settings/mainFuse.ts';
import {
  settingsMainFuseAmpsInput,
  settingsMainFuseEnabledInput,
  settingsMainFuseFields,
  settingsMainFuseHint,
  settingsMainFuseSupplySelect,
} from './dom.ts';

const FUSE_SIZE_PROMPT = 'Enter the size printed on your main fuse, such as 25 A.';

const readFormFuse = (): MainFuse | null => {
  if (settingsMainFuseEnabledInput?.selected !== true) return { kind: 'off' };
  const supply = settingsMainFuseSupplySelect?.value;
  const amps = Number.parseFloat(settingsMainFuseAmpsInput?.value ?? '');
  return isMainFuseSupply(supply) && isValidMainFuseAmps(amps) ? { kind: 'on', supply, amps } : null;
};

export const refreshMainFuseControls = (): void => {
  if (settingsMainFuseFields) settingsMainFuseFields.hidden = settingsMainFuseEnabledInput?.selected !== true;
  if (!settingsMainFuseHint) return;
  const fuse = readFormFuse();
  settingsMainFuseHint.textContent = fuse === null || fuse.kind === 'off'
    ? FUSE_SIZE_PROMPT
    : `PELS starts reducing loads near ${gridImportTargetKw(mainFuseTotalKw(fuse)).toFixed(1)} kW.`;
};

export const bindMainFuseControls = (): void => {
  settingsMainFuseEnabledInput?.addEventListener('change', refreshMainFuseControls);
  settingsMainFuseSupplySelect?.addEventListener('change', refreshMainFuseControls);
  settingsMainFuseAmpsInput?.addEventListener('input', refreshMainFuseControls);
};

export const syncMainFuseControls = (fuse: MainFuse): void => {
  if (settingsMainFuseEnabledInput) settingsMainFuseEnabledInput.selected = fuse.kind === 'on';
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
