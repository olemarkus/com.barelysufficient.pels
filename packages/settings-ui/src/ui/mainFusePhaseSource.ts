import { HOMEY_ENERGY_METERS_PATH, SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import type { HomeyEnergyMeterEntry, SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';
import {
  MAIN_FUSE_PHASE_CAPABILITIES,
  MAIN_FUSE_PHASE_METER_DEVICE_ID,
  POWER_SOURCE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  isMainFusePhaseCapabilities,
  resolvePhaseCapabilityFacet,
  type MainFusePhaseCapabilities,
} from '../../../shared-domain/src/settings/mainFusePhaseSource.ts';
import { callApi, getApiReadModel, getSetting, setSetting } from './homey.ts';
import { classifyPhaseLoad } from './phaseLoadRead.ts';
import { createSelectOption } from './advanced.ts';
import { logSettingsError } from './logging.ts';
import type { MdFilledSelectElement } from './dom.ts';
import { showToastError } from './toast.ts';

/**
 * Where PELS reads the phases when it cannot find them on its own: the owner
 * picks the meter's capabilities (a meter with no recognised phases), or, for a
 * Flow-source home, a meter device to read them from. No new route: the power
 * payload carries the capability list, and these are ordinary settings.
 */

const q = <T extends Element>(id: string): T | null => document.querySelector<T>(id);
const NOT_SET = '';

const fieldsEl = q<HTMLElement>('#settings-main-fuse-phase-source');
const meterFieldEl = q<HTMLElement>('#settings-main-fuse-phase-meter-field');
const meterSelectEl = q<MdFilledSelectElement>('#settings-main-fuse-phase-meter');
const capabilitiesFieldEl = q<HTMLElement>('#settings-main-fuse-phase-capabilities-field');
const capabilitiesHintEl = q<HTMLElement>('#settings-main-fuse-phase-capabilities-hint');
const phaseSelects = (['L1', 'L2', 'L3'] as const).map((phase) => ({
  phase, select: q<MdFilledSelectElement>(`#settings-main-fuse-phase-${phase}`),
}));

const replaceOptions = (
  select: MdFilledSelectElement | null,
  options: readonly { value: string; label: string }[],
  selected: string,
): void => {
  if (!select) return;
  select.replaceChildren(...options.map(({ value, label }) => createSelectOption(value, label, value === selected)));
  // eslint-disable-next-line no-param-reassign -- the element's own value property
  select.value = selected;
};

/** A capability as an owner reads it: `measure_power.l1` is "Power L1". */
export const formatPhaseCapabilityLabel = (capabilityId: string): string => {
  const kind = resolvePhaseCapabilityFacet(capabilityId) === 'current' ? 'Current' : 'Power';
  const name = capabilityId.slice(capabilityId.indexOf('.') + 1).replace(/[_-]+/gu, ' ').trim();
  return `${kind} ${/^[a-z]\d$/iu.test(name) ? name.toUpperCase() : name}`;
};

const renderCapabilities = (ids: readonly string[], saved: MainFusePhaseCapabilities | null): void => {
  const candidates = ids.filter((id) => resolvePhaseCapabilityFacet(id) !== null);
  if (capabilitiesFieldEl) capabilitiesFieldEl.hidden = candidates.length === 0;
  const options = [
    { value: NOT_SET, label: 'Not set' },
    ...candidates.map((id) => ({ value: id, label: formatPhaseCapabilityLabel(id) })),
  ];
  for (const { phase, select } of phaseSelects) replaceOptions(select, options, saved?.[phase] ?? NOT_SET);
};

const renderMeters = async (selectedId: string | null): Promise<void> => {
  const meters = await callApi<HomeyEnergyMeterEntry[]>('GET', HOMEY_ENERGY_METERS_PATH);
  replaceOptions(meterSelectEl, [
    { value: NOT_SET, label: 'None' },
    ...meters.map((meter) => ({ value: meter.id, label: meter.name })),
  ], selectedId ?? NOT_SET);
};

/** Fill the block from the runtime's reads; answers whether the meter gives power without current. */
const renderPhaseSource = async (block: HTMLElement): Promise<boolean> => {
  const [powerSource, meterDeviceId, capabilities, power] = await Promise.all([
    getSetting(POWER_SOURCE),
    getSetting(MAIN_FUSE_PHASE_METER_DEVICE_ID),
    getSetting(MAIN_FUSE_PHASE_CAPABILITIES),
    getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH),
  ]);
  const isFlow = powerSource === 'flow';
  if (meterFieldEl) meterFieldEl.hidden = !isFlow;
  if (isFlow) await renderMeters(typeof meterDeviceId === 'string' ? meterDeviceId : null);
  const load = classifyPhaseLoad(power?.phaseLoad);
  const saved = isMainFusePhaseCapabilities(capabilities) ? capabilities : null;
  // Recognised phases need no picker; a choice the owner made stays changeable once it works.
  const recognised = load.state === 'phases' || load.phasesRecognised === true;
  renderCapabilities(!recognised || saved !== null ? load.meterCapabilityIds ?? [] : [], saved);
  // An empty block would still take its grid gaps under the fuse hint.
  // eslint-disable-next-line no-param-reassign -- the element's own hidden flag
  block.hidden = meterFieldEl?.hidden !== false && capabilitiesFieldEl?.hidden !== false;
  return load.state === 'phases' && load.powerOnly === true;
};

/** Show the row when it can help, on the same Limits form as the fuse itself. */
export const syncMainFusePhaseSource = async (
  supply: string | undefined,
  onPhaseKind: (powerOnly: boolean) => void,
): Promise<void> => {
  if (!fieldsEl) return;
  const applies = supply === 'three_phase_neutral';
  if (!applies) fieldsEl.hidden = true;
  if (!applies) return;
  try {
    onPhaseKind(await renderPhaseSource(fieldsEl));
  } catch (error) {
    await logSettingsError('Failed to load the main fuse phase source', error, 'mainFusePhaseSource');
  }
};

/** The three chosen capabilities as a setting, or why they cannot be one. */
export const resolveCapabilityChoice = (
  values: readonly string[],
): { kind: 'none' } | { kind: 'mixed' } | { kind: 'choice'; value: MainFusePhaseCapabilities } => {
  const [l1, l2, l3] = values;
  if (values.every((value) => value === NOT_SET)) return { kind: 'none' };
  if (!l1 || !l2 || !l3) return { kind: 'mixed' };
  const facet = resolvePhaseCapabilityFacet(l1);
  if (facet === null || resolvePhaseCapabilityFacet(l2) !== facet || resolvePhaseCapabilityFacet(l3) !== facet) {
    return { kind: 'mixed' };
  }
  return { kind: 'choice', value: { facet, L1: l1, L2: l2, L3: l3 } };
};

const saveSetting = async (key: string, value: unknown): Promise<void> => {
  try {
    await setSetting(key, value);
  } catch (error) {
    await showToastError(error, 'Failed to save the phase source.');
  }
};

export const bindMainFusePhaseSource = (): void => {
  meterSelectEl?.addEventListener('change', () => {
    const value = meterSelectEl.value;
    void saveSetting(MAIN_FUSE_PHASE_METER_DEVICE_ID, value === NOT_SET ? null : value);
  });
  for (const { select } of phaseSelects) {
    select?.addEventListener('change', () => {
      const choice = resolveCapabilityChoice(phaseSelects.map((entry) => entry.select?.value ?? NOT_SET));
      if (capabilitiesHintEl) capabilitiesHintEl.hidden = choice.kind !== 'mixed';
      if (choice.kind === 'mixed') return;
      void saveSetting(MAIN_FUSE_PHASE_CAPABILITIES, choice.kind === 'choice' ? choice.value : null);
    });
  }
};
