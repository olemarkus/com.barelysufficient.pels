import type { ContinuousBatteryPlanConfigs } from '../../../contracts/src/continuousBatteryPlan.ts';
import { getChosenWholeHomeMeterName, WHOLE_HOME_METER_CHANGED } from './homeyEnergyMeter.ts';
import { settingsCapacityLimitInput, settingsPowerSourceSelect } from './dom.ts';
import { h, render } from 'preact';
import { CHARGING_SETUP_UPDATED, FINISH_CHARGING_SETUP, VEHICLE_CHARGING_SETUP_HINT,
  vehicleChargingConsentMissing } from './chargingSetupFacts.ts';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import {
  hasOpenSmartTask, resolveHomeHasSolar, resolveSolarSurplusPending,
  resolveSolarSurplusPendingNote, state,
} from './state.ts';
import { supportsTemperatureControlDevice, type SettingsUiDeviceListItem } from './deviceUtils.ts';
import {
  getPrimaryTargetCapability, normalizeTargetCapabilityValue,
} from '../../../shared-domain/src/targetCapabilities.ts';
import { showTab } from './tabNavigation.ts';
import { selectHomeScope, subscribeToHomeScope, getHomeScope } from './homeScope.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  readSetupReview, readSetupMarket, onSetupPathChange, notifySetupPathChange, readSetupLimitsInForce,
  isSetupDeviceLimitable, readUnchosenSetupHardCap,
} from './setupPathFacts.ts';
import type { SetupStep, SetupPath } from './setupPathModel.ts';
import { isMainFuseMarket, nextSetupStep } from './setupPathModel.ts';
import {
  currentSetupJourney, setupSavePending, waitForSetupSaves, type SetupJourneyStep,
  acknowledgeSetupSaveFailures,
} from './setupJourneyState.ts';
import {
  REVIEW_DEVICE_NO_JOB, SetupJourneyHeader, SetupReview, type SetupReviewDevice, type SetupJourneyHeaderProps,
  type SetupHardCapChoice,
} from './views/SetupJourney.tsx';
import { renderDevices } from './devices.ts';
import { refreshDevicesForUi } from './uiRefreshTasks.ts';
import { setEditingMode } from './modes.ts';
import { chargingPriorityGroup, orderModePriorityDevices, rankDisplayedModePriorities } from './modePriorityDisplay.ts';
import {
  loadCapacitySettings, loadStaleDataStatus, saveSimulationModeSettings, saveCapacityPeriodSettings,
  autoSaveSettingsLimits, saveCapacityOffSettings,
} from './capacity.ts';
import { flushDebouncedSettingSaves } from './utils.ts';
import { formatHardCapKw } from './monthPeakHoldCopy.ts';
import { resolveSolarSetupAction, retrySetupDeviceReads } from './setupDevices.ts';
import { getPowerReadModel } from './power.ts';
import { getApiReadModel, invalidateApiCache } from './homey.ts';
import {
  SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH, SETTINGS_UI_PLAN_PATH,
} from '../../../contracts/src/settingsUi/paths.ts';
import { loadDeferredObjectiveSettings, waitForDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { logSettingsError } from './logging.ts';
import { type SettingsUiPlanPayload } from '../../../contracts/src/settingsUi/plan.ts';
import { parsePlanSnapshot } from './planSnapshotParse.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { readActiveRecommendation, dismissSetupRecommendation } from './recommendations.ts';
import { resolveSetupGoalChoices } from './setupGoals.ts';
import { followsPrices, readMainHomeManagedDevices } from './mainHomeDevices.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import {
  acceptSetupBatteryPlans, countSetupBatteryPlansOn, isSetupBatteryPlanOn, loadSetupBatteryPlans,
  onSetupBatteryPlansChange, retrySetupBatteryPlans,
} from './setupBatteryPlan.ts';

let actionBusy = false;
let error: string | null = null;
let meterLine: string | null = null;
// Whether this visit has shown `Choose what PELS does`. Navigation, not
// completion: Continue offers the page once, then goes on to the review, so a
// step the page reopens (Prices, once a device follows them) does not lead
// back to it. Never persisted.
let goalsShown = false;
let prioritiesShown = false;
// The Dutch main-fuse offer is optional and shown once per visit.
let limitsShown = false;
// Whether this visit came from the simulation banner with setup unfinished.
// Only then is someone looking for the way out of simulation; guided setup
// itself keeps to its steps. Never persisted.
let simulationExitOffered = false;

const usesFlowMeter = (): boolean => settingsPowerSourceSelect?.value === 'flow';

const meterSummary = (): string | null => {
  const name = usesFlowMeter() ? 'Flow' : getChosenWholeHomeMeterName();
  return [name, meterLine].filter(Boolean).join(' · ') || null;
};
let statuses = new Map<string, string>();
let liveReadGeneration = 0;

const PANEL_BY_STEP: Record<SetupJourneyStep, string> = {
  power: 'limits', devices: 'devices', hardCap: 'limits',
  prices: 'electricity-prices', goals: 'devices', priorities: 'modes', review: 'setup-review',
};

const currentStep = (): SetupJourneyStep | null => {
  const step = currentSetupJourney();
  return step && document.querySelector(`[data-panel="${PANEL_BY_STEP[step]}"]:not(.hidden)`) ? step : null;
};

const navigateStep = (step: SetupStep): void => {
  selectHomeScope(MAIN_HOME_ID);
  showTab(step.target.panel, step.id);
};

export const openSetupReview = (): void => {
  selectHomeScope(MAIN_HOME_ID);
  const path = readSetupReview();
  const next = path && nextSetupStep(path);
  simulationExitOffered = Boolean(next);
  if (next) navigateStep(next);
  else showTab('setup-review', 'review');
};

const runAction = async (action: () => Promise<void>): Promise<void> => {
  if (actionBusy) return;
  actionBusy = true;
  error = null;
  paintJourney();
  try {
    await flushDebouncedSettingSaves();
    await waitForSetupSaves();
    await action();
  } catch (caught) {
    acknowledgeSetupSaveFailures();
    error = caught instanceof Error ? caught.message : 'Could not save your settings. Try again.';
  } finally {
    actionBusy = false;
    paintJourney();
  }
};

const openSetupGoals = (): void => {
  selectHomeScope(MAIN_HOME_ID);
  showTab('devices', 'goals');
};

// Once the required steps are done, optional choices come before the review.
const goalsComeNext = (): boolean => {
  if (goalsShown) return false;
  const choices = resolveSetupGoalChoices();
  return choices.state === 'ready' && (choices.hasActions || choices.devices.some(({ battery }) => battery !== null));
};

const mainFuseComesNext = (path: SetupPath): boolean => {
  const step = currentStep();
  return !limitsShown && path.offersMainFuse && (step === 'power' || step === 'devices');
};

const prioritiesComeNext = (): boolean => {
  const managed = readMainHomeManagedDevices();
  return !prioritiesShown && managed.state === 'ready' && managed.devices.length >= 2;
};

const continueSetup = (): void => {
  void runAction(async () => {
    const review = readSetupReview();
    if (!review) throw new Error('Setup could not be read. Return to setup and try again.');
    if (currentStep() === 'priorities') prioritiesShown = true;
    const next = nextSetupStep(review);
    if ((!next || next.id === 'prices') && mainFuseComesNext(review)) showTab('limits', 'hardCap');
    else if (next) navigateStep(next);
    else if (goalsComeNext()) openSetupGoals();
    else if (prioritiesComeNext()) showTab('modes', 'priorities');
    else showTab('setup-review', 'review');
  });
};

const startManaging = (): void => {
  void runAction(async () => {
    await waitForDeferredObjectiveSettings();
    const review = readSetupReview();
    if (!review || nextSetupStep(review)) {
      throw new Error('Complete the remaining setup steps first.');
    }
    await saveSimulationModeSettings(false);
    showTab('overview');
  });
};

// Power-limit control has something to act on while a limit is in force, and
// a battery's also while there is solar to store. Until the limits have been
// read it is named as saved.
const limitControlActs = (device: SettingsUiDeviceListItem): boolean => (
  readSetupLimitsInForce() !== false || (isHomeBatteryClassKey(device.deviceClass) && resolveHomeHasSolar())
);

const solarChargingSetupMissing = (deviceId: string): boolean => (
  state.priceOptimizationSettings[deviceId]?.surplusWilling === true && vehicleChargingConsentMissing(deviceId)
);

// What PELS will do with the device once it manages it: each saved control
// that has something to act on. Price-based control acts while PELS responds to
// prices, as Power-limit control does while a limit is in force.
const describeDeviceJobs = (device: SettingsUiDeviceListItem): string | null => {
  if (state.loadedModeHomeId !== MAIN_HOME_ID) return null;
  if (solarChargingSetupMissing(device.id)) return REVIEW_DEVICE_NO_JOB;
  const solar = resolveSolarSetupAction(device);
  const jobs = [
    supportsTemperatureControlDevice(device) ? 'Follows mode temperatures' : null,
    isSetupDeviceLimitable(device.id) && limitControlActs(device) ? 'Power-limit control on' : null,
    isSetupDeviceLimitable(device.id) && isSetupBatteryPlanOn(device.id) ? 'Plan charging with PELS on' : null,
    followsPrices(device) ? 'Price-based control on' : null,
    hasOpenSmartTask(device.id) ? 'Smart task set' : null,
    solar?.configured ? solar.label : null,
  ].filter((job): job is string => job !== null);
  return jobs.length > 0 ? jobs.join(' · ') : REVIEW_DEVICE_NO_JOB;
};

const readReviewDevices = (): SetupReviewDevice[] => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready') return [];
  const mode = state.loadedModeHomeId === MAIN_HOME_ID ? state.activeMode : null;
  const ordered = mode === null ? managed.devices
    : orderModePriorityDevices(state.modePriorityCatalog, mode, managed.devices);
  return rankDisplayedModePriorities(ordered, chargingPriorityGroup)
    .map(({ item: device, rank }) => ({
      id: device.id,
      name: formatDisplayDeviceName(device.name),
      control: describeDeviceJobs(device),
      status: statuses.get(device.id) ?? null,
      ...(solarChargingSetupMissing(device.id) ? {
        setupAction: { label: FINISH_CHARGING_SETUP, focus: 'charging-control' as const,
          hint: VEHICLE_CHARGING_SETUP_HINT },
      } : {}),
      configuration: [
        ...(mode === null ? [] : [`Priority ${rank}`]),
        ...readReviewTarget(device, mode),
      ],
    }));
};

const readReviewTarget = (device: SettingsUiDeviceListItem, mode: string | null): string[] => {
  if (mode === null || !supportsTemperatureControlDevice(device)) return [];
  const saved = state.modeTargets[mode]?.[device.id];
  if (saved === undefined) return [];
  const target = normalizeTargetCapabilityValue({ target: getPrimaryTargetCapability(device.targets), value: saved });
  return [`Mode target: ${target} °C`];
};

// Solar control on its way: the review and `Choose what PELS does` say so.
const solarPending = (): boolean => resolveSolarSurplusPending();

const solarPendingNote = (): string => (
  resolveSolarSurplusPendingNote(usesFlowMeter())
);

const resolveReviewSolarNote = (devices: readonly SetupReviewDevice[]): string | null => {
  if (!solarPending()) return null;
  return devices.some((device) => state.priceOptimizationSettings[device.id]?.surplusWilling)
    ? null : solarPendingNote();
};

const paintReview = (): void => {
  const root = document.getElementById('setup-review-root');
  if (!root) return;
  const path = readSetupReview();
  const devices = readReviewDevices();
  const goals = resolveSetupGoalChoices();
  const retryAvailable = state.devicesReadState === 'unavailable'
    || state.deferredObjectiveSettingsReadState === 'unavailable';
  render(h(SetupReview, {
    path,
    devices,
    activeMode: state.loadedModeHomeId === MAIN_HOME_ID ? state.activeMode : null,
    meterSummary: meterSummary(),
    busy: actionBusy || setupSavePending(),
    error,
    solarNote: resolveReviewSolarNote(devices),
    onRetry: retryAvailable ? () => { void runAction(retrySetupReview); } : undefined,
    onStart: startManaging,
    onContinue: continueSetup,
    hasGoalActions: goals.state === 'ready' && goals.hasActions,
    onChooseGoals: goals.state === 'ready' && goals.devices.length > 0 ? openSetupGoals : null,
    onOpenDevice: dispatchOpenDeviceDetail,
  }), root);
};

const headerTitle = (step: SetupJourneyStep): string => {
  if (step === 'power') return 'Connect your meter';
  if (step === 'devices') return 'Choose one device to start';
  if (step === 'hardCap') return 'Confirm your limits';
  if (step === 'goals') return 'Choose what PELS does';
  if (step === 'priorities') return 'Choose what stays on longest';
  return 'Confirm your price source';
};

const mountHeader = (panelId: string): HTMLElement | null => {
  const panel = document.querySelector<HTMLElement>(`[data-panel="${panelId}"]`);
  if (!panel) return null;
  let mount = panel.querySelector<HTMLElement>(':scope > .setup-journey-root');
  if (!mount) {
    mount = document.createElement('div');
    mount.className = 'setup-journey-root';
    panel.prepend(mount);
  }
  return mount;
};

// The price source is the home's, so the page names it once, and says once
// when solar control is still on its way.
const goalsHeaderDetail = (): string => {
  const choices = resolveSetupGoalChoices();
  const intro = choices.state === 'ready' && !choices.hasActions
    ? 'See what PELS needs for each device.'
    : 'Optional. You can change each choice later on its device page.';
  const source = choices.state === 'ready' && choices.hasActions && choices.priceSource !== null
    ? ` PELS uses your prices from ${choices.priceSource}.` : '';
  const solar = solarPending() ? ` ${solarPendingNote()}` : '';
  return `${intro}${source}${solar}`;
};

const headerDetail = (step: SetupJourneyStep, fact: SetupStep | undefined): string | null => {
  if (step === 'power') {
    const reading = fact?.status === 'done' ? meterSummary() : null;
    return reading ?? fact?.detail ?? 'Reading meter settings…';
  }
  if (step === 'goals') return goalsHeaderDetail();
  if (step === 'priorities') return `Optional. In ${state.activeMode}, the top device keeps running longest. `
    + (countSetupBatteryPlansOn() >= 2 ? 'Batteries higher in the list are also planned first. ' : '')
    + 'Drag to change the order, or continue with the current order. You can change it later in Modes.';
  if (step === 'devices') return fact?.status === 'done' ? fact.detail : null;
  return fact?.detail ?? null;
};

const optionalMainFuseDetail = (step: SetupJourneyStep, path: SetupPath | null): string | null => (
  step === 'hardCap' && path?.offersMainFuse
    ? 'Optional. Set your main fuse to protect each phase. '
      + 'One phase can overload even when solar on another offsets its draw.'
    : null
);

// Dutch and French households pay by connection or subscription size, so the
// open Limits step offers the way out its detail explains, in one tap. A new
// install there starts with Capacity limit off; this is for one from before that
// default, still running the built-in 10 kW. Here the switch moves only when the
// owner taps.
const offersCapacityOff = (step: SetupJourneyStep, fact: SetupStep | undefined): boolean => {
  if (step !== 'hardCap' || fact === undefined || fact.status === 'done') return false;
  return isMainFuseMarket(readSetupMarket());
};

// Optional choices are outside the four setup stages, so they show no count.
const headerProgress = (step: SetupJourneyStep, path: SetupPath | null): string | null => {
  if (step === 'goals' || step === 'priorities') return null;
  if (!path) return 'Loading…';
  const index = path.steps.findIndex((candidate) => candidate.id === step);
  return index < 0 ? null : `Step ${index + 1} of ${path.steps.length}`;
};

// Every step done and managing started: the after-setup suggestion opens
// `Choose what PELS does` on its own, with no journey around it.
const setupFinished = (path: SetupPath | null): boolean => (
  path !== null && !nextSetupStep(path) && !path.simulating
);

const continueLabel = (path: SetupPath | null): string => (
  path !== null && !nextSetupStep(path) && !mainFuseComesNext(path) && !goalsComeNext() && !prioritiesComeNext()
    ? 'Review setup' : 'Continue'
);

const simulationExitStep = (path: SetupPath | null): string | null => {
  if (!simulationExitOffered || !state.dryRun) return null;
  return path ? nextSetupStep(path)?.title ?? null : null;
};

const canContinueSetup = (step: SetupJourneyStep, fact: SetupStep | undefined): boolean => (
  step === 'goals' || step === 'priorities' || fact?.status === 'done' || fact?.status === 'unchecked'
);

const canKeepHardCap = (limitKw: number): boolean => {
  const value = settingsCapacityLimitInput?.value.trim();
  return Boolean(value) && Number(value) === limitKw;
};

const focusHardCap = (): void => {
  settingsCapacityLimitInput?.scrollIntoView({ block: 'center' });
  settingsCapacityLimitInput?.focus({ preventScroll: true });
};

const resolveHardCapHeaderChoice = (
  step: SetupJourneyStep, fact: SetupStep | undefined, market: ReturnType<typeof readSetupMarket>,
): SetupHardCapChoice | null => {
  if (step !== 'hardCap' || (fact?.status !== 'next' && fact?.status !== 'later') || isMainFuseMarket(market)) {
    return null;
  }
  const hardCap = readUnchosenSetupHardCap();
  if (hardCap === null) return null;
  const { runningLimitKw, periodMinutes } = hardCap;
  const label = formatHardCapKw(runningLimitKw);
  const period = periodMinutes === 15 ? '15-minute' : 'hourly';
  return {
    label,
    detail: `PELS uses ${label} as the hard cap for your ${period} average grid import.`,
    canKeep: canKeepHardCap(runningLimitKw),
    onKeep: () => {
      if (canKeepHardCap(runningLimitKw)) void autoSaveSettingsLimits();
    },
    onChange: focusHardCap,
  };
};

const readReviewBatterySetupAction = (step: SetupJourneyStep): (() => void) | undefined => {
  if (step !== 'devices') return undefined;
  const choices = resolveSetupGoalChoices();
  if (choices.state === 'ready' && choices.devices.some(({ battery }) => battery !== null)) return openSetupGoals;
  return undefined;
};

const headerProps = (step: SetupJourneyStep, path: SetupPath | null): SetupJourneyHeaderProps => {
  const fact = path?.steps.find((candidate) => candidate.id === step);
  const market = readSetupMarket();
  const advice = step === 'hardCap' ? readActiveRecommendation('market:flanders-capacity-period') : null;
  const hardCapChoice = resolveHardCapHeaderChoice(step, fact, market);
  return {
    onReviewBatterySetup: readReviewBatterySetupAction(step),
    title: headerTitle(step),
    progress: headerProgress(step, path),
    detail: hardCapChoice?.detail ?? optionalMainFuseDetail(step, path) ?? headerDetail(step, fact),
    busy: actionBusy || setupSavePending(),
    // The optional page never holds the journey back.
    canContinue: canContinueSetup(step, fact),
    error,
    meterHelp: step === 'goals' && solarPending() && usesFlowMeter(),
    fluviusHelp: step === 'power' && fact?.status !== 'done' && market.state === 'resolved' && market.country === 'BE',
    continueLabel: continueLabel(path),
    journeyActions: step !== 'goals' || !setupFinished(path),
    onContinue: continueSetup,
    onCheckMeter: () => showTab('limits', 'power'),
    quarterHourAdvice: advice !== null,
    onQuarterHour: () => { void runAction(() => saveCapacityPeriodSettings(15)); },
    simulationExitStep: simulationExitStep(path),
    onOpenSimulation: () => showTab('simulation'),
    capacityOffAction: offersCapacityOff(step, fact),
    onCapacityOff: () => { void runAction(saveCapacityOffSettings); },
    hardCapChoice,
    onDismissQuarterHour: () => {
      if (advice) void dismissSetupRecommendation(advice).then(paintJourney);
    },
  };
};

const paintJourney = (): void => {
  const step = currentStep();
  for (const panel of document.querySelectorAll<HTMLElement>('[data-setup-journey-panel]')) {
    delete panel.dataset.setupJourneyPanel;
  }
  for (const mount of document.querySelectorAll<HTMLElement>('.setup-journey-root')) mount.hidden = true;
  if (!step) return;
  if (step === 'review') { paintReview(); return; }
  if (step === 'goals') goalsShown = true;
  if (step === 'priorities') {
    if (state.loadedModeHomeId === MAIN_HOME_ID) prioritiesShown = true;
    // A prior Modes visit may still show another mode until its reload lands.
    if (state.editingMode !== state.activeMode) setEditingMode(state.activeMode);
  }
  const root = mountHeader(PANEL_BY_STEP[step]);
  if (!root) return;
  const path = readSetupReview();
  if (step === 'hardCap' && path !== null) limitsShown = true;
  root.hidden = false;
  root.parentElement!.dataset.setupJourneyPanel = step;
  render(h(SetupJourneyHeader, headerProps(step, path)), root);
};

const repaintJourney = (): void => {
  paintJourney();
  const step = currentStep();
  if (step === 'goals' || step === 'devices') renderDevices(state.latestDevices);
};

const formatMeterReading = (kw: number, stamp: number): string => {
  const time = new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${Number(kw.toFixed(2))} kW · Updated ${time}`;
};

const refreshLivePreview = async (): Promise<void> => {
  if (!currentStep()) return;
  const generation = ++liveReadGeneration;
  const [powerRead, planRead] = await Promise.allSettled([
    getPowerReadModel(), getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH),
  ]);
  if (generation !== liveReadGeneration || !currentStep()) return;
  if (powerRead.status === 'fulfilled') {
    const power = powerRead.value;
    const kw = power.status.state === 'live' ? power.status.status.powerNowKw : null;
    meterLine = power.readings.state === 'received' && typeof kw === 'number' && Number.isFinite(kw)
      ? formatMeterReading(kw, power.readings.lastPowerUpdateMs)
      : null;
  } else meterLine = null;
  const plan = planRead.status === 'fulfilled' ? parsePlanSnapshot(planRead.value.plan) : null;
  statuses = new Map((plan?.devices ?? []).map((device) => {
    const display = resolveDisplayPlanDeviceSnapshot(device, Date.now());
    return [device.id, [display.status.label, display.status.reason?.text].filter(Boolean).join(' · ')];
  }));
  paintJourney();
};

export const retrySetupPathReads = async (): Promise<void> => {
  const reads = [loadStaleDataStatus(), retrySetupBatteryPlans()];
  if (state.deferredObjectiveSettingsReadState === 'unavailable') {
    invalidateApiCache(SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH);
    reads.push(loadDeferredObjectiveSettings().catch((error) => (
      logSettingsError('Failed to reload the Smart Task roster', error, 'setup')
    )));
  }
  await Promise.all(reads);
};

const retrySetupReview = async (): Promise<void> => {
  if (state.devicesReadState === 'unavailable') retrySetupDeviceReads();
  await retrySetupPathReads();
};

export const initSetupJourney = (): void => {
  settingsCapacityLimitInput?.addEventListener('input', () => {
    if (currentStep() === 'hardCap') paintJourney();
  });
  document.addEventListener(CHARGING_SETUP_UPDATED, repaintJourney);
  document.addEventListener(WHOLE_HOME_METER_CHANGED, paintJourney);
  void loadSetupBatteryPlans();
  document.addEventListener('pels:tab-shown', () => {
    error = null;
    const step = currentStep();
    if (step) {
      selectHomeScope(MAIN_HOME_ID);
      window.scrollTo(0, 0);
      if (step === 'goals' || step === 'review') void loadSetupBatteryPlans();
    } else {
      simulationExitOffered = false;
      acknowledgeSetupSaveFailures();
    }
    paintJourney();
    if (state.devicesLoaded) renderDevices(state.latestDevices);
    void refreshLivePreview();
  });
  // A save starting or ending, or a setup fact arriving, changes what the page
  // offers and whether its controls are busy, not only its header.
  document.addEventListener('pels:setup-save', repaintJourney);
  document.addEventListener('pels:recommendations-updated', paintJourney);
  document.addEventListener('modes-loaded', () => { notifySetupPathChange(); paintJourney(); });
  document.addEventListener('devices-updated', () => {
    void retrySetupBatteryPlans();
    paintJourney();
    notifySetupPathChange();
  });
  document.addEventListener('device-detail-closed', () => {
    if (currentStep() === 'goals') {
      refreshDevicesForUi();
      void loadSetupBatteryPlans();
    }
    if (state.devicesLoaded) renderDevices(state.latestDevices);
    paintJourney();
  });
  document.addEventListener('plan-updated', () => { void refreshLivePreview(); });
  // A task created from `Choose what PELS does` lands after the page is back,
  // and a task can open the Prices step: the cards and the header both repaint.
  document.addEventListener('deferred-objectives-updated', () => {
    notifySetupPathChange();
    if (currentStep() === 'goals') renderDevices(state.latestDevices);
  });
  onSetupPathChange(repaintJourney);
  // The battery row and the review read the saved battery plans; a save on the
  // battery's own page changes them too.
  onSetupBatteryPlansChange(repaintJourney);
  document.addEventListener('continuous-battery-plan-changed', (event) => {
    acceptSetupBatteryPlans((event as CustomEvent<ContinuousBatteryPlanConfigs>).detail);
  });
  subscribeToHomeScope(() => {
    const step = currentStep();
    // Choosing an area leaves the Main-home journey and opens its ordinary settings.
    if (step && getHomeScope().selectedHomeId !== MAIN_HOME_ID) showTab(PANEL_BY_STEP[step]);
    else if (step === 'devices' || step === 'goals') renderDevices(state.latestDevices);
  });
  // Direct links into the review also need the accepted limits/provenance.
  if (currentSetupJourney()) void loadCapacitySettings().then(paintJourney);
};
