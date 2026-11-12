import { render } from 'preact';
import type {
  BatteryEfficiencyMeasurement, ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead,
} from '../../../../contracts/src/continuousBatteryPlan.ts';
import { SETTINGS_UI_DEVICES_PATH } from '../../../../contracts/src/settingsUi/paths.ts';
import { isHomeBatteryClassKey } from '../../../../shared-domain/src/batteryOrSolarRole.ts';
import { MAIN_HOME_ID } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { isUnknownRecord } from '../../../../shared-domain/src/recordGuards.ts';
import type { SettingsUiDeviceDetailItem, SettingsUiDeviceListItem } from '../deviceUtils.ts';
import { getHomeyTimezone, invalidateApiCache } from '../homey.ts';
import { getPricesReadModel } from '../prices.ts';
import { getHomeIdForUiDevice } from '../homeScopeMembership.ts';
import { resolveBatteryPowerLimitOn, resolveManagedState, state } from '../state.ts';
import { formatSettingsError } from '../toast.ts';
import { createSerializedAsyncRunner } from './settingsWrite.ts';
import { resolveBatteryManagedHint } from './batterySection.ts';
import { ContinuousBatteryPlanLoading, ContinuousBatteryPlanView } from '../views/ContinuousBatteryPlan.tsx';
import {
  countOtherEnabledBatteryPlans, loadBatteryEfficiencyMeasurement, loadContinuousBatteryPlan,
  saveContinuousBatteryPlanConfig,
} from './continuousBatteryPlanTransport.ts';

type BatteryPlanSession = {
  deviceId: string;
  drivable: boolean;
  blockedReason: string;
  read: ContinuousBatteryPlanRead | null;
  efficiency: BatteryEfficiencyMeasurement;
  /** Other batteries with the plan on: they plan together, in priority order. */
  otherEnabledPlans: number;
  /** The saved settings the form edits: the read's config, or a config just saved. */
  config: ContinuousBatteryPlanConfig | null;
  /** The unit the prices are in now, or `null` until prices have been read. */
  priceUnit: string | null;
  busy: boolean;
  error: string;
  loading: boolean;
  previewAvailable: boolean;
  generation: number;
};

let session: BatteryPlanSession | null = null;
const saveSerialized = createSerializedAsyncRunner();

const container = () => document.getElementById('device-detail-battery-plan');

function display(current: BatteryPlanSession): void {
  const mount = container();
  if (!mount || session !== current) return;
  const managedHint = document.getElementById('device-detail-managed-hint');
  if (managedHint && current.drivable && current.read !== null) {
    // A blocked or waiting plan says so below; the hint claims planning only while a plan runs.
    managedHint.textContent = current.read.status === 'planned' && current.blockedReason === ''
      ? 'PELS plans charging and household supply, and holds your power limit. Turn off battery planning to return to its own schedule.'
      : resolveBatteryManagedHint();
  }
  if (current.read === null || current.config === null) {
    render(<ContinuousBatteryPlanLoading failed={current.error !== ''} onRetry={() => refresh(current)} />, mount);
    return;
  }
  render(<ContinuousBatteryPlanView key={current.deviceId} read={current.read} efficiency={current.efficiency} otherEnabledPlans={current.otherEnabledPlans} config={current.config} priceUnit={current.priceUnit}
    timeZone={getHomeyTimezone()} blockedReason={current.blockedReason} busy={current.busy}
    error={current.error} previewAvailable={current.previewAvailable}
    onSave={config => save(current, config)} onRefresh={() => refresh(current)} />, mount);
}

async function refresh(current: BatteryPlanSession): Promise<void> {
  invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
  await load(current);
}

async function load(current: BatteryPlanSession): Promise<void> {
  const generation = ++current.generation;
  current.loading = true;
  try {
    const [read, efficiency, otherEnabledPlans, prices] = await Promise.all([
      loadContinuousBatteryPlan(current.deviceId),
      loadBatteryEfficiencyMeasurement(current.deviceId).catch((): BatteryEfficiencyMeasurement => ({ status: 'unavailable' })),
      countOtherEnabledBatteryPlans(current.deviceId).catch(() => 0),
      getPricesReadModel().catch(() => null),
    ]);
    if (session !== current || generation !== current.generation) return;
    current.read = read;
    current.efficiency = efficiency;
    current.otherEnabledPlans = otherEnabledPlans;
    current.config = read.config;
    current.previewAvailable = true;
    const combined = prices?.combinedPrices;
    current.priceUnit = null;
    if (read.status === 'planned') current.priceUnit = read.priceUnit;
    else if (isUnknownRecord(combined) && typeof combined.priceUnit === 'string' && combined.priceUnit.trim()) {
      current.priceUnit = combined.priceUnit;
    }
    current.error = '';
  } catch (error) {
    if (session !== current || generation !== current.generation) return;
    current.error = formatSettingsError(error, 'Battery planning could not be loaded. Try again.');
  } finally {
    if (session === current && generation === current.generation) {
      current.loading = false;
      display(current);
    }
  }
}

const save = (current: BatteryPlanSession, config: ContinuousBatteryPlanConfig): Promise<boolean> => saveSerialized(async () => {
  if (session !== current) return false;
  current.busy = true;
  current.error = '';
  display(current);
  try {
    const saved = await saveContinuousBatteryPlanConfig(current.deviceId, config);
    current.config = saved;
    current.previewAvailable = false;
    await load(current);
    if (current.error) current.error = `Battery plan saved. ${current.error}`;
    return true;
  } catch (error) {
    current.error = formatSettingsError(error, 'Battery plan could not be saved. Try again.');
    return false;
  } finally {
    current.busy = false;
    display(current);
  }
});

/**
 * What stops PELS from running this battery's plan, apart from Simulation
 * mode, or `''` when nothing does. Setup's battery row reads it too: there
 * Simulation mode is the journey's own posture, ended by Start managing.
 */
export const resolveBatteryPlanControlBlock = (device: Pick<SettingsUiDeviceListItem, 'id' | 'batteryControl'>): string => {
  if (getHomeIdForUiDevice(device.id) !== MAIN_HOME_ID) return 'Continuous battery planning is available in the main home.';
  if (device.batteryControl === 'needs_homey_api_key') return 'Add a Homey API key with Flow permission to let PELS execute the battery plan.';
  if (device.batteryControl !== 'drivable') return 'The battery app must give Homey a power setting and a Homey or API control mode.';
  if (!resolveManagedState(device.id)) return 'Turn on Managed by PELS to let PELS plan battery use.';
  if (!resolveBatteryPowerLimitOn(device.id)) return 'Turn on Power-limit control to let PELS execute the battery plan.';
  return '';
};

const blockedReasonFor = (device: SettingsUiDeviceDetailItem): string => {
  const block = resolveBatteryPlanControlBlock(device);
  if (block !== '') return block;
  if (state.dryRun) return 'Simulation mode sends no battery commands. Turn it off to execute the battery plan.';
  return '';
};

/** Owns the selected battery's network reads; old responses cannot paint a different device. */
export function setContinuousBatteryPlanDevice(device: SettingsUiDeviceDetailItem | null): void {
  const section = document.getElementById('device-detail-battery-plan-section');
  const visible = device !== null && isHomeBatteryClassKey(device.deviceClass);
  if (section) section.hidden = !visible;
  if (!visible || !device) {
    session = null;
    const mount = container();
    if (mount) render(null, mount);
    return;
  }
  const blockedReason = blockedReasonFor(device);
  if (session?.deviceId === device.id) {
    session.drivable = device.batteryControl === 'drivable';
    session.blockedReason = blockedReason;
    display(session);
    return;
  }
  session = { deviceId: device.id, drivable: device.batteryControl === 'drivable', blockedReason, read: null, efficiency: { status: 'unavailable' }, otherEnabledPlans: 0, config: null, priceUnit: null, busy: false,
    error: '', loading: false, previewAvailable: true, generation: 0 };
  display(session);
  void load(session);
}

export function initContinuousBatteryPlanRefresh(): void {
  document.addEventListener('plan-updated', () => {
    if (session !== null && !session.busy && !session.loading) void refresh(session);
  });
}
