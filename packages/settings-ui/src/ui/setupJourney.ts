import { getChosenWholeHomeMeterName } from './homeyEnergyMeter.ts';
import { settingsPowerSourceSelect } from './dom.ts';
import { h, render } from 'preact';
import { hasOpenSmartTask, resolveHomeHasSolar, state } from './state.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { showTab } from './tabNavigation.ts';
import { selectHomeScope, subscribeToHomeScope, getHomeScope } from './homeScope.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  readSetupReview, readSetupMarket, onSetupPathChange, notifySetupPathChange, readSetupLimitsInForce,
} from './setupPathFacts.ts';
import { formatSetupProgress, type SetupStep, type SetupPath } from './setupPathModel.ts';
import {
  currentSetupJourney, setupSavePending, waitForSetupSaves, type SetupJourneyStep,
  acknowledgeSetupSaveFailures,
} from './setupJourneyState.ts';
import {
  SetupJourneyHeader, SetupReview, type SetupReviewDevice, type SetupJourneyHeaderProps,
} from './views/SetupJourney.tsx';
import { renderDevices } from './devices.ts';
import {
  loadCapacitySettings, saveSimulationModeSettings, saveCapacityPeriodSettings, saveCapacityOffSettings,
} from './capacity.ts';
import { flushDebouncedSettingSaves } from './utils.ts';
import { resolveSolarSetupAction } from './setupDevices.ts';
import { getPowerReadModel } from './power.ts';
import { getApiReadModel } from './homey.ts';
import { SETTINGS_UI_PLAN_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { type SettingsUiPlanPayload } from '../../../contracts/src/settingsUi/plan.ts';
import { parsePlanSnapshot } from './planSnapshotParse.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { readActiveRecommendation, dismissSetupRecommendation } from './recommendations.ts';
import { offersSetupGoals, resolveSetupGoalChoices } from './setupGoals.ts';
import { followsPrices, readMainHomeManagedDevices } from './mainHomeDevices.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';

let actionBusy = false;
let error: string | null = null;
let meterLine: string | null = null;
// Whether this visit has shown `Choose what PELS does`. Navigation, not
// completion: Continue offers the page once, then goes on to the review, so a
// step the page reopens (Prices, once a device follows them) does not lead
// back to it. Never persisted.
let goalsShown = false;

const usesFlowMeter = (): boolean => settingsPowerSourceSelect?.value === 'flow';

const meterSummary = (): string | null => {
  const name = usesFlowMeter() ? 'Flow' : getChosenWholeHomeMeterName();
  return [name, meterLine].filter(Boolean).join(' · ') || null;
};
let statuses = new Map<string, string>();
let liveReadGeneration = 0;

const PANEL_BY_STEP: Record<SetupJourneyStep, string> = {
  power: 'limits', devices: 'devices', hardCap: 'limits',
  prices: 'electricity-prices', goals: 'devices', review: 'setup-review',
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
  const next = readSetupReview()?.steps.find((step) => step.status !== 'done');
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

// Once the required steps are done, the optional page comes before the review.
const goalsComeNext = (): boolean => !goalsShown && offersSetupGoals();

const continueSetup = (): void => {
  void runAction(async () => {
    const review = readSetupReview();
    if (!review) throw new Error('Setup could not be read. Return to setup and try again.');
    const next = review.steps.find((step) => step.status !== 'done');
    if (next) navigateStep(next);
    else if (goalsComeNext()) openSetupGoals();
    else showTab('setup-review', 'review');
  });
};

const startManaging = (): void => {
  void runAction(async () => {
    const review = readSetupReview();
    if (!review || review.doneCount !== review.steps.length) {
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

// What PELS will do with the device once it manages it: each saved control
// that has something to act on. Price-based control acts while PELS responds to
// prices, as Power-limit control does while a limit is in force.
const describeDeviceJobs = (device: SettingsUiDeviceListItem): string => {
  const solar = resolveSolarSetupAction(device);
  const jobs = [
    state.controllableMap[device.id] === true && limitControlActs(device) ? 'Power-limit control on' : null,
    followsPrices(device) ? 'Price-based control on' : null,
    hasOpenSmartTask(device.id) ? 'Smart task set' : null,
    solar?.configured ? solar.label : null,
  ].filter((job): job is string => job !== null);
  return jobs.length > 0 ? jobs.join(' · ') : 'Nothing for PELS to do yet';
};

const readReviewDevices = (): SetupReviewDevice[] => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready') return [];
  return managed.devices.map((device) => ({
      id: device.id,
      name: formatDisplayDeviceName(device.name),
      control: describeDeviceJobs(device),
      status: statuses.get(device.id) ?? null,
    }));
};

// Before PELS has seen its first surplus, solar control is waiting, not broken:
// an evening or winter install simply has not had one yet. Worded like the solar
// suggestion so it holds for a home that curtails instead of exporting.
const SOLAR_SURPLUS_PENDING = 'Solar control appears once PELS sees your solar produce more than '
  + 'the home is using.';

// The known way surplus stays hidden for good is a Flow that reports import
// without its sign (`resolveSurplusControlAvailable`): the home never shows
// producing more than it uses. So only a Flow home gets the meter check while
// solar is still waiting. Worded as the getting-started guide's meter step.
const FLOW_SIGN_NOTE = 'Your Flow must send net import, negative when exporting.';

// A home with solar that has not shown its first surplus: solar control is on
// its way, and the review and `Choose what PELS does` say so.
const solarPending = (): boolean => (
  state.devicesLoaded && resolveHomeHasSolar() && !state.surplusPoolReachable
);

const solarPendingNote = (): string => (
  usesFlowMeter() ? `${SOLAR_SURPLUS_PENDING} ${FLOW_SIGN_NOTE}` : SOLAR_SURPLUS_PENDING
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
  render(h(SetupReview, {
    path,
    devices,
    meterSummary: meterSummary(),
    busy: actionBusy || setupSavePending(),
    error,
    solarNote: resolveReviewSolarNote(devices),
    onStart: startManaging,
    onContinue: continueSetup,
    onChooseGoals: offersSetupGoals() ? openSetupGoals : null,
  }), root);
};

const headerTitle = (step: SetupJourneyStep): string => {
  if (step === 'power') return 'Connect your meter';
  if (step === 'devices') return 'Choose one device to start';
  if (step === 'hardCap') return 'Confirm your limits';
  if (step === 'goals') return 'Choose what PELS does';
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
  const source = choices.state === 'ready' && choices.priceSource !== null
    ? ` PELS uses your prices from ${choices.priceSource}.` : '';
  const solar = solarPending() ? ` ${solarPendingNote()}` : '';
  return `Optional. You can change each choice later on its device page.${source}${solar}`;
};

const headerDetail = (step: SetupJourneyStep, fact: SetupStep | undefined): string | null => {
  if (step === 'power') {
    const reading = fact?.status === 'done' ? meterSummary() : null;
    return reading ?? fact?.detail ?? 'Reading meter settings…';
  }
  if (step === 'goals') return goalsHeaderDetail();
  if (step === 'devices') return null;
  return fact?.detail ?? null;
};

// Dutch households pay by connection size, so the open Limits step offers the
// way out its detail explains, in one tap. A new Dutch install starts with
// Capacity limit off; this is for one from before that default, still running
// the built-in 10 kW. Here the switch moves only when the owner taps.
const offersCapacityOff = (step: SetupJourneyStep, fact: SetupStep | undefined): boolean => {
  if (step !== 'hardCap' || fact === undefined || fact.status === 'done') return false;
  const market = readSetupMarket();
  return market.state === 'resolved' && market.country === 'NL';
};

// The optional page is not one of the counted steps, so it shows no count.
const headerProgress = (step: SetupJourneyStep, path: SetupPath | null): string | null => {
  if (step === 'goals') return null;
  return path ? formatSetupProgress(path) : 'Loading…';
};

const continueLabel = (path: SetupPath | null): string => (
  path !== null && path.doneCount === path.steps.length && !goalsComeNext() ? 'Review setup' : 'Continue'
);

const headerProps = (step: SetupJourneyStep, path: SetupPath | null): SetupJourneyHeaderProps => {
  const fact = path?.steps.find((candidate) => candidate.id === step);
  const market = readSetupMarket();
  const advice = step === 'hardCap' ? readActiveRecommendation('market:flanders-capacity-period') : null;
  return {
    title: headerTitle(step),
    progress: headerProgress(step, path),
    detail: headerDetail(step, fact),
    busy: actionBusy || setupSavePending(),
    // The optional page never holds the journey back.
    canContinue: step === 'goals' || fact?.status === 'done',
    error,
    meterHelp: step === 'goals' && solarPending() && usesFlowMeter(),
    fluviusHelp: step === 'power' && fact?.status !== 'done' && market.state === 'resolved' && market.country === 'BE',
    continueLabel: continueLabel(path),
    onContinue: continueSetup,
    onCheckMeter: () => showTab('limits', 'power'),
    quarterHourAdvice: advice !== null,
    onQuarterHour: () => { void runAction(() => saveCapacityPeriodSettings(15)); },
    capacityOffAction: offersCapacityOff(step, fact),
    onCapacityOff: () => { void runAction(saveCapacityOffSettings); },
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
  const root = mountHeader(PANEL_BY_STEP[step]);
  if (!root) return;
  root.hidden = false;
  root.parentElement!.dataset.setupJourneyPanel = step;
  render(h(SetupJourneyHeader, headerProps(step, readSetupReview())), root);
};

const repaintJourney = (): void => {
  paintJourney();
  if (currentStep() === 'goals' && state.devicesLoaded) renderDevices(state.latestDevices);
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

export const initSetupJourney = (): void => {
  document.addEventListener('pels:tab-shown', () => {
    error = null;
    if (currentStep()) {
      selectHomeScope(MAIN_HOME_ID);
      window.scrollTo(0, 0);
    } else acknowledgeSetupSaveFailures();
    paintJourney();
    if (state.devicesLoaded) renderDevices(state.latestDevices);
    void refreshLivePreview();
  });
  // A save starting or ending, or a setup fact arriving, changes what the page
  // offers and whether its controls are busy, not only its header.
  document.addEventListener('pels:setup-save', repaintJourney);
  document.addEventListener('pels:recommendations-updated', paintJourney);
  document.addEventListener('devices-updated', () => { paintJourney(); notifySetupPathChange(); });
  document.addEventListener('device-detail-closed', () => {
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
  subscribeToHomeScope(() => {
    const step = currentStep();
    // Choosing an area leaves the Main-home journey and opens its ordinary settings.
    if (step && getHomeScope().selectedHomeId !== MAIN_HOME_ID) showTab(PANEL_BY_STEP[step]);
    else if (step === 'devices' || step === 'goals') renderDevices(state.latestDevices);
  });
  // Direct links into the review also need the accepted limits/provenance.
  if (currentSetupJourney()) void loadCapacitySettings().then(paintJourney);
};
