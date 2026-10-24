import { getChosenWholeHomeMeterName } from './homeyEnergyMeter.ts';
import { settingsPowerSourceSelect } from './dom.ts';
import { h, render } from 'preact';
import { state } from './state.ts';
import { showTab } from './tabNavigation.ts';
import { selectHomeScope, readHomeMembership, subscribeToHomeScope, getHomeScope } from './homeScope.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { readSetupReview, readSetupMarket, onSetupPathChange, notifySetupPathChange } from './setupPathFacts.ts';
import { formatSetupProgress, type SetupStep, type SetupPath } from './setupPathModel.ts';
import {
  currentSetupJourney, isSolarSetupJourney, setupSavePending, waitForSetupSaves, type SetupJourneyStep,
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
import { SETTINGS_UI_PLAN_PATH, type SettingsUiPlanPayload } from '../../../contracts/src/settingsUiApi.ts';
import { parsePlanSnapshot } from './planSnapshotParse.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { readActiveRecommendation, dismissSetupRecommendation } from './recommendations.ts';

let actionBusy = false;
let error: string | null = null;
let meterLine: string | null = null;

const meterSummary = (): string | null => {
  const name = settingsPowerSourceSelect?.value === 'flow' ? 'Flow' : getChosenWholeHomeMeterName();
  return [name, meterLine].filter(Boolean).join(' · ') || null;
};
let statuses = new Map<string, string>();
let liveReadGeneration = 0;

const PANEL_BY_STEP: Record<SetupJourneyStep, string> = {
  power: 'limits', devices: 'devices', solar: 'devices', hardCap: 'limits',
  prices: 'electricity-prices', review: 'setup-review',
};

const currentStep = (): SetupJourneyStep | null => {
  const step = currentSetupJourney();
  return step && document.querySelector(`[data-panel="${PANEL_BY_STEP[step]}"]:not(.hidden)`) ? step : null;
};

const navigateStep = (step: SetupStep): void => {
  selectHomeScope(MAIN_HOME_ID);
  showTab(step.target.panel, step.id === 'devices' && isSolarSetupJourney() ? 'solar' : step.id);
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

const continueSetup = (): void => {
  void runAction(async () => {
    const review = readSetupReview();
    if (!review) throw new Error('Setup could not be read. Return to setup and try again.');
    const next = review.steps.find((step) => step.status !== 'done');
    if (next) navigateStep(next);
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

const normalDeviceControl = (deviceId: string): string => (
  state.controllableMap[deviceId] === true ? 'Power-limit control on' : 'Managed by PELS'
);

const readReviewDevices = (): SetupReviewDevice[] => {
  const membership = readHomeMembership();
  if (membership.state !== 'resolved') return [];
  return state.latestDevices.filter((device) => state.managedMap[device.id] === true
    && (!membership.runtimeActive || (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID))
    .map((device) => {
      const solar = resolveSolarSetupAction(device);
      return {
        id: device.id,
        name: formatDisplayDeviceName(device.name),
        control: solar?.configured ? solar.label : normalDeviceControl(device.id),
        status: statuses.get(device.id) ?? null,
      };
    });
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
    solarPending: isSolarSetupJourney()
      && !devices.some((device) => state.priceOptimizationSettings[device.id]?.surplusWilling),
    onStart: startManaging,
    onContinue: continueSetup,
  }), root);
};

const headerTitle = (step: SetupJourneyStep): string => {
  if (step === 'power') return 'Connect your meter';
  if (step === 'solar') return 'Use more of your own solar';
  if (step === 'devices') return 'Choose one device to start';
  if (step === 'hardCap') return 'Confirm your limits';
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

const headerDetail = (step: SetupJourneyStep, fact: SetupStep | undefined): string | null => {
  if (step === 'power') {
    const reading = fact?.status === 'done' ? meterSummary() : null;
    return reading ?? fact?.detail ?? 'Reading meter settings…';
  }
  if (step === 'solar' && state.devicesLoaded && !state.surplusPoolReachable) {
    return 'Waiting for usable solar readings. Check the meter and solar devices in Homey.';
  }
  if (step === 'devices' || step === 'solar') return null;
  return fact?.detail ?? null;
};

// Dutch households pay by connection size, so the open Limits step offers the
// way out its detail explains, in one tap. Geography only offers it: the switch
// moves when the owner taps, never on its own.
const offersCapacityOff = (step: SetupJourneyStep, fact: SetupStep | undefined): boolean => {
  if (step !== 'hardCap' || fact === undefined || fact.status === 'done') return false;
  const market = readSetupMarket();
  return market.state === 'resolved' && market.country === 'NL';
};

const headerProps = (step: SetupJourneyStep, path: SetupPath | null): SetupJourneyHeaderProps => {
  const fact = path?.steps.find((candidate) => candidate.id === (step === 'solar' ? 'devices' : step));
  const market = readSetupMarket();
  const advice = step === 'hardCap' ? readActiveRecommendation('market:flanders-capacity-period') : null;
  return {
    title: headerTitle(step),
    progress: path ? formatSetupProgress(path) : 'Loading…',
    detail: headerDetail(step, fact),
    busy: actionBusy || setupSavePending(),
    canContinue: fact?.status === 'done',
    error,
    meterHelp: step === 'solar' && state.devicesLoaded && !state.surplusPoolReachable,
    fluviusHelp: step === 'power' && fact?.status !== 'done' && market.state === 'resolved' && market.country === 'BE',
    continueLabel: path !== null && path.doneCount === path.steps.length ? 'Review setup' : 'Continue',
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
  const root = mountHeader(PANEL_BY_STEP[step]);
  if (!root) return;
  root.hidden = false;
  root.parentElement!.dataset.setupJourneyPanel = step;
  render(h(SetupJourneyHeader, headerProps(step, readSetupReview())), root);
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
  document.addEventListener('pels:setup-save', paintJourney);
  document.addEventListener('pels:recommendations-updated', paintJourney);
  document.addEventListener('devices-updated', () => { paintJourney(); notifySetupPathChange(); });
  document.addEventListener('device-detail-closed', () => {
    if (state.devicesLoaded) renderDevices(state.latestDevices);
    paintJourney();
  });
  document.addEventListener('plan-updated', () => { void refreshLivePreview(); });
  onSetupPathChange(paintJourney);
  subscribeToHomeScope(() => {
    const step = currentStep();
    // Choosing an area leaves the Main-home journey and opens its ordinary settings.
    if (step && getHomeScope().selectedHomeId !== MAIN_HOME_ID) showTab(PANEL_BY_STEP[step]);
    else if (step === 'devices' || step === 'solar') renderDevices(state.latestDevices);
  });
  // Direct links into the review also need the accepted limits/provenance.
  if (currentSetupJourney()) void loadCapacitySettings().then(paintJourney);
};
