import {
  classifyPowerReadingsFact,
  resolveAreaPowerReadingsBannerContent,
  resolvePowerReadingsBannerContent,
  type PowerReadingsBannerContent,
  type PowerReadingsBannerInput,
  type PowerReadingsFact,
} from '../../../shared-domain/src/powerReadingsBanner.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { staleDataBanner, staleDataBannerAction, staleDataBannerText } from './dom.ts';
import { getChosenWholeHomeMeterName, hasChosenWholeHomeMeter } from './homeyEnergyMeter.ts';
import { getHomeScope, getShownPanelHomeId, subscribeToHomeScope } from './homeScope.ts';
import { getSilentMeterPass } from './planMeasurementSignal.ts';
import { isNoReadingsCarriedBySetupPath, publishSetupPower } from './setupPathFacts.ts';
import { readUsagePower } from './usagePowerRead.ts';
import { currentSetupJourney } from './setupJourneyState.ts';

// A never-received fact always resolves banner content; this only keeps the type honest.
const NO_READINGS_YET_FALLBACK = 'No power readings yet.';

type MainBannerRead = {
  readings: PowerReadingsFact;
  source: PowerReadingsBannerInput['source'];
  knownSingleHome: boolean;
};

let mainRead: MainBannerRead | undefined;
let shownHomeId: string = MAIN_HOME_ID;
let areaRead: PowerReadingsFact | undefined;
let areaReadGeneration = 0;

type BannerDestination = { target: 'limits'; anchor: string } | { target: 'homes' };

const paintBanner = (content: PowerReadingsBannerContent | null, destination: BannerDestination): void => {
  if (!staleDataBanner) return;
  staleDataBanner.hidden = content === null;
  if (content === null) return;
  if (staleDataBannerText) staleDataBannerText.textContent = content.text;
  if (!staleDataBannerAction) return;
  staleDataBannerAction.textContent = content.actionLabel;
  const { dataset } = staleDataBannerAction;
  dataset.settingsTarget = destination.target;
  if (destination.target === 'limits') {
    dataset.settingsAnchor = destination.anchor;
    dataset.settingsHomeScope = MAIN_HOME_ID;
  } else {
    delete dataset.settingsAnchor;
    delete dataset.settingsHomeScope;
  }
};

const resolveMainBanner = ({ readings, source }: MainBannerRead): PowerReadingsBannerContent | null => (
  resolvePowerReadingsBannerContent({
    readings,
    nowMs: Date.now(),
    silentMeterPass: getSilentMeterPass(),
    // The select mirrors the persisted source (and a drafted Homey Energy
    // switch, where the picker hint is exactly right).
    source,
    meterChosen: hasChosenWholeHomeMeter(),
    meterName: getChosenWholeHomeMeterName(),
  })
);

const paintSelectedBanner = (): void => {
  const homeId = getShownPanelHomeId();
  if (homeId === MAIN_HOME_ID) {
    const askingBeforeMeterSetup = mainRead?.readings.state === 'never' && currentSetupJourney() === 'intent';
    const content = mainRead && !askingBeforeMeterSetup && !isNoReadingsCarriedBySetupPath(mainRead.knownSingleHome)
      ? resolveMainBanner(mainRead) : null;
    const useMeterPicker = mainRead?.readings.state === 'received' && mainRead.source === 'homey_energy';
    const anchor = useMeterPicker ? '#settings-homey-energy-meter' : '#settings-power-source';
    paintBanner(content, { target: 'limits', anchor });
    return;
  }
  const name = getHomeScope().areas.find((area) => area.homeId === homeId)?.name;
  const content = shownHomeId === homeId && areaRead !== undefined && name !== undefined
    ? resolveAreaPowerReadingsBannerContent(areaRead, Date.now(), name) : null;
  paintBanner(content, { target: 'homes' });
};

/** Accept only Main facts here, including the fact consumed by the setup path. */
export const renderPowerReadingsBanner = (
  readings: PowerReadingsFact | null,
  source: PowerReadingsBannerInput['source'],
  knownSingleHome: boolean,
): boolean => {
  const latest = readings ?? mainRead?.readings;
  if (latest === undefined) return false;
  mainRead = { readings: latest, source, knownSingleHome };
  // The setup path's Power meter step says this same sentence where it stands
  // in for the banner, so it is handed the banner's words rather than its own.
  publishSetupPower(latest.state === 'never'
    ? { state: 'never', remedy: resolveMainBanner(mainRead)?.text ?? NO_READINGS_YET_FALLBACK }
    : { state: 'received' });
  paintSelectedBanner();
  return true;
};

/** Repaint on scope moves before any network response can put the previous meter under the new scope. */
export const refreshAreaPowerReadingsBanner = async (): Promise<void> => {
  const homeId = getShownPanelHomeId();
  const generation = ++areaReadGeneration;
  if (shownHomeId !== homeId) {
    shownHomeId = homeId;
    areaRead = undefined;
  }
  paintSelectedBanner();
  if (homeId === MAIN_HOME_ID) return;
  const read = await readUsagePower();
  if (generation !== areaReadGeneration || homeId !== getShownPanelHomeId() || read.state !== 'served') return;
  const readings = classifyPowerReadingsFact(read.payload.readings);
  if (readings === null) return;
  areaRead = readings;
  paintSelectedBanner();
};

const onScopeChanged = (): void => { void refreshAreaPowerReadingsBanner(); };
subscribeToHomeScope(onScopeChanged);
document.addEventListener('pels:tab-shown', onScopeChanged);
