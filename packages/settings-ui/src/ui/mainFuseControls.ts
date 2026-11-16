import type { MainFuse, MainFuseSupply } from '../../../contracts/src/capacitySettings.ts';
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
  settingsMainFuseKvaSelect,
  settingsMainFuseSizeLabel,
  settingsMainFuseSupplySelect,
  settingsMainFuseUnitSegmented,
  settingsMainFuseUnitSelect,
} from './dom.ts';
import { createSelectOption } from './advanced.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { bindSegmentedToSelect } from './segmentedControl.ts';
import { onSetupPathChange, readSetupMarket } from './setupPathFacts.ts';
import { showToastError } from './toast.ts';
import {
  MAIN_FUSE_ENTRY_UNIT_KEY,
  formatMainFuseAmps,
  mainFuseAmpsFromKva,
  mainFuseKva,
  mainFuseKvaSteps,
  matchingMainFuseKvaStep,
  resolveMainFuseEntryUnit,
  type MainFuseEntryUnit,
} from './mainFuseKva.ts';

import { bindMainFusePhaseSource, syncMainFusePhaseSource } from './mainFusePhaseSource.ts';

const FUSE_SIZE_PROMPT = 'Use the number on your connection, like the 25 in 3x25 A or the 35 in 1x35 A.';
const FUSE_SIZE_ERROR = 'Enter a size from 6 to 250 A.';
const KVA_PROMPT = 'The subscribed power in your electricity contract. It is on your bill and your meter.';
const KVA_NOT_SET = '';

type OnFuse = Extract<MainFuse, { kind: 'on' }>;

let phasesPowerOnly = false;
// The fuse as last stored, and its size (kept while the fuse is off). Until the
// owner picks a subscription, a kVA form stands for the stored fuse unchanged,
// and a size field still showing the rounded stored amps reads back as the
// exact amps: switching units never rewrites the fuse.
let savedFuse: MainFuse = { kind: 'off' };
let savedAmps: number | null = null;
let storedUnit: MainFuseEntryUnit | null = null;
let unitSegmented: { refresh: () => void } | null = null;

// France states the connection as a subscribed power; everyone else reads a fuse.
const resolveUnit = (): MainFuseEntryUnit => {
  if (storedUnit) return storedUnit;
  const market = readSetupMarket();
  return market.state === 'resolved' && market.country === 'FR' ? 'kva' : 'amps';
};

const readSupply = (): MainFuseSupply | null => {
  const supply = settingsMainFuseSupplySelect?.value;
  return isMainFuseSupply(supply) ? supply : null;
};

const readFormAmps = (): number => {
  const raw = settingsMainFuseAmpsInput?.value ?? '';
  if (savedAmps !== null && raw === formatMainFuseAmps(savedAmps)) return savedAmps;
  return Number.parseFloat(raw);
};

const readKvaFuse = (supply: MainFuseSupply): MainFuse | null => {
  const kva = Number.parseFloat(settingsMainFuseKvaSelect?.value ?? KVA_NOT_SET);
  if (Number.isFinite(kva)) return { kind: 'on', supply, amps: mainFuseAmpsFromKva(kva, supply) };
  // No subscription picked: the stored fuse stays exactly as it is, and a fuse
  // turned back on takes its kept size, as it does in amps.
  if (savedFuse.kind === 'on') return savedFuse.supply === supply ? savedFuse : null;
  return savedAmps === null ? null : { kind: 'on', supply, amps: savedAmps };
};

const readFormFuse = (): MainFuse | null => {
  if (settingsMainFuseEnabledInput?.selected !== true) return { kind: 'off' };
  const supply = readSupply();
  if (!supply) return null;
  if (resolveUnit() === 'kva') return readKvaFuse(supply);
  const amps = readFormAmps();
  return isValidMainFuseAmps(amps) ? { kind: 'on', supply, amps } : null;
};

const hasInvalidSize = (): boolean => {
  if (resolveUnit() === 'kva') return false;
  const raw = settingsMainFuseAmpsInput?.value ?? '';
  return settingsMainFuseEnabledInput?.selected === true && raw !== '' && !isValidMainFuseAmps(readFormAmps());
};

const formatFuseHint = (fuse: OnFuse): string => {
  const totalKw = gridImportTargetKw(mainFuseTotalKw(fuse)).toFixed(1);
  if (fuse.supply !== 'three_phase_neutral') return `PELS starts reducing loads near ${totalKw} kW.`;
  const phaseKw = mainFusePhaseTargetKw(fuse.amps, !phasesPowerOnly).toFixed(1);
  return `PELS starts reducing loads near ${phaseKw} kW per phase (${totalKw} kW in total).`;
};

const formatFuseName = (fuse: OnFuse): string => (
  `${fuse.supply === 'one_phase' ? '1' : '3'}x${formatMainFuseAmps(fuse.amps)} A`
);

// A stored fuse that is no subscription: say what it is and that it still holds.
const formatUnpickedKvaHint = (fuse: MainFuse | null): string => {
  if (fuse?.kind !== 'on') return KVA_PROMPT;
  return `Your fuse, ${formatFuseName(fuse)}, is about ${mainFuseKva(fuse).toFixed(1)} kVA. `
    + `PELS keeps using it until you pick your subscribed power. ${formatFuseHint(fuse)}`;
};

const formatHint = (fuse: MainFuse | null): string => {
  const kva = resolveUnit() === 'kva';
  if (kva && settingsMainFuseKvaSelect?.value === KVA_NOT_SET) return formatUnpickedKvaHint(fuse);
  if (fuse === null || fuse.kind === 'off') return kva ? KVA_PROMPT : FUSE_SIZE_PROMPT;
  return formatFuseHint(fuse);
};

const renderFuseSizeFeedback = (): void => {
  const invalid = hasInvalidSize();
  settingsMainFuseAmpsInput?.toggleAttribute('error', invalid);
  settingsMainFuseAmpsInput?.setAttribute('error-text', invalid ? FUSE_SIZE_ERROR : '');
  if (!settingsMainFuseHint) return;
  settingsMainFuseHint.hidden = invalid;
  settingsMainFuseHint.textContent = formatHint(readFormFuse());
};

const renderKvaOptions = (supply: MainFuseSupply | null, selected: string): void => {
  if (!settingsMainFuseKvaSelect) return;
  const steps = supply ? mainFuseKvaSteps(supply) : [];
  const value = steps.some((kva) => String(kva) === selected) ? selected : KVA_NOT_SET;
  settingsMainFuseKvaSelect.replaceChildren(
    createSelectOption(KVA_NOT_SET, 'Not set', value === KVA_NOT_SET),
    ...steps.map((kva) => createSelectOption(String(kva), `${kva} kVA`, String(kva) === value)),
  );
  settingsMainFuseKvaSelect.value = value;
};

// The subscription a fuse was saved from; a fuse entered in amps matches none.
const kvaChoiceFor = (fuse: MainFuse | null): string => {
  const step = fuse?.kind === 'on' ? matchingMainFuseKvaStep(fuse) : null;
  return step === null ? KVA_NOT_SET : String(step);
};

// The fuse the form shows in the incoming unit; with the fuse off, its kept size.
const shownFuse = (fuse: MainFuse | null): OnFuse | null => {
  if (fuse?.kind === 'on') return fuse;
  const supply = readSupply();
  return supply && savedAmps !== null ? { kind: 'on', supply, amps: savedAmps } : null;
};

// Each unit shows the same fuse, the other one converted; nothing here saves.
const renderUnit = (fuse: MainFuse | null): void => {
  const unit = resolveUnit();
  const shown = shownFuse(fuse);
  if (settingsMainFuseUnitSelect) settingsMainFuseUnitSelect.value = unit;
  if (settingsMainFuseSizeLabel) {
    settingsMainFuseSizeLabel.textContent = unit === 'kva' ? 'Subscribed power' : 'Fuse size per phase';
  }
  if (settingsMainFuseAmpsInput) {
    settingsMainFuseAmpsInput.hidden = unit === 'kva';
    if (unit === 'amps' && shown) settingsMainFuseAmpsInput.value = formatMainFuseAmps(shown.amps);
  }
  if (settingsMainFuseKvaSelect) settingsMainFuseKvaSelect.hidden = unit !== 'kva';
  if (unit === 'kva') renderKvaOptions(readSupply(), kvaChoiceFor(shown));
  unitSegmented?.refresh();
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

const saveUnit = async (unit: MainFuseEntryUnit): Promise<void> => {
  try {
    await setSetting(MAIN_FUSE_ENTRY_UNIT_KEY, unit);
  } catch (error) {
    await logSettingsError('Failed to save the main fuse unit', error, 'mainFuseUnit');
    await showToastError(error, 'Could not save how you enter the main fuse.');
  }
};

// Switching units changes the form only: the fuse saves when a size or subscription is chosen.
const switchUnit = (unit: MainFuseEntryUnit): void => {
  if (storedUnit === unit) return;
  // Read in the outgoing unit, so the incoming one shows the same fuse.
  const fuse = readFormFuse() ?? savedFuse;
  storedUnit = unit;
  renderUnit(fuse);
  refreshMainFuseControls();
  void saveUnit(unit);
};

const loadStoredUnit = async (): Promise<void> => {
  try {
    const read = resolveMainFuseEntryUnit(await getSetting(MAIN_FUSE_ENTRY_UNIT_KEY));
    // A unit the owner picked while this read was pending is newer.
    if (storedUnit === null) storedUnit = read;
  } catch (error) {
    await logSettingsError('Failed to read the main fuse unit', error, 'mainFuseUnit');
  }
  renderUnit(savedFuse);
  refreshMainFuseControls();
};

/** Saved like the other limits: the moment the form holds a fuse PELS can use. */
export const bindMainFuseControls = (autoSave: () => Promise<void>): void => {
  bindMainFusePhaseSource();
  const refreshAndSave = (): void => {
    refreshMainFuseControls();
    if (readFormFuse() === null) {
      (resolveUnit() === 'kva' ? settingsMainFuseKvaSelect : settingsMainFuseAmpsInput)?.focus();
      return;
    }
    void autoSave();
  };
  settingsMainFuseEnabledInput?.addEventListener('change', refreshAndSave);
  settingsMainFuseSupplySelect?.addEventListener('change', () => {
    // The same subscription on the new supply; a size in amps keeps its number.
    if (resolveUnit() === 'kva') renderKvaOptions(readSupply(), settingsMainFuseKvaSelect?.value ?? KVA_NOT_SET);
    refreshAndSave();
  });
  settingsMainFuseAmpsInput?.addEventListener('input', refreshMainFuseControls);
  settingsMainFuseAmpsInput?.addEventListener('change', refreshAndSave);
  settingsMainFuseKvaSelect?.addEventListener('change', refreshAndSave);
  if (settingsMainFuseUnitSegmented && settingsMainFuseUnitSelect) {
    unitSegmented = bindSegmentedToSelect({
      container: settingsMainFuseUnitSegmented,
      select: settingsMainFuseUnitSelect,
    });
  }
  settingsMainFuseUnitSelect?.addEventListener('change', () => {
    const unit = resolveMainFuseEntryUnit(settingsMainFuseUnitSelect?.value);
    if (unit) switchUnit(unit);
  });
  // The market lands after the first paint; it only picks the unit nobody chose.
  onSetupPathChange(() => {
    if (storedUnit !== null) return;
    renderUnit(savedFuse);
    refreshMainFuseControls();
  });
  void loadStoredUnit();
};

export const syncMainFuseControls = (fuse: MainFuse, storedAmps: unknown): void => {
  savedFuse = fuse;
  const keptAmps = isValidMainFuseAmps(storedAmps) ? storedAmps : null;
  savedAmps = fuse.kind === 'on' ? fuse.amps : keptAmps;
  if (settingsMainFuseEnabledInput) settingsMainFuseEnabledInput.selected = fuse.kind === 'on';
  if (fuse.kind === 'on' && settingsMainFuseSupplySelect) settingsMainFuseSupplySelect.value = fuse.supply;
  // Kept while off, so turning the fuse back on needs no retyping.
  if (savedAmps !== null && settingsMainFuseAmpsInput) settingsMainFuseAmpsInput.value = formatMainFuseAmps(savedAmps);
  renderUnit(fuse);
  refreshMainFuseControls();
};

/** The form's fuse, for a save. An enabled switch needs a valid size or a subscription. */
export const readMainFuseForm = (): MainFuse => {
  const fuse = readFormFuse();
  if (fuse !== null) return fuse;
  throw new Error(resolveUnit() === 'kva'
    ? 'Pick your subscribed power for the main fuse.'
    : 'Main fuse size must be between 6 and 250 A.');
};

/** The form's fuse without throwing: `null` while it holds no fuse PELS can use. */
export const peekMainFuseForm = (): MainFuse | null => readFormFuse();

/** The fuse as last stored, for a save that compares against it. */
export const readSavedMainFuse = (): MainFuse => savedFuse;

/** Put the form back to the stored fuse, after the owner kept the saved limits. */
export const restoreSavedMainFuseForm = (): void => syncMainFuseControls(savedFuse, savedAmps);
