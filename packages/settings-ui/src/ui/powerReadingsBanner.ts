import {
  resolvePowerReadingsBannerContent,
  type PowerReadingsBannerInput,
  type PowerReadingsFact,
} from '../../../shared-domain/src/powerReadingsBanner.ts';
import { staleDataBanner, staleDataBannerAction, staleDataBannerText } from './dom.ts';
import { getChosenWholeHomeMeterName, hasChosenWholeHomeMeter } from './homeyEnergyMeter.ts';
import { isPlanUnmeasured } from './planMeasurementSignal.ts';
import { isNoReadingsCarriedBySetupPath, publishSetupPower } from './setupPathFacts.ts';

// A never-received fact always resolves banner content; this only keeps the type honest.
const NO_READINGS_YET_FALLBACK = 'No power readings yet.';

export const renderPowerReadingsBanner = (
  readings: PowerReadingsFact,
  source: PowerReadingsBannerInput['source'],
  knownSingleHome: boolean,
): void => {
  const content = resolvePowerReadingsBannerContent({
    readings,
    nowMs: Date.now(),
    planUnmeasured: isPlanUnmeasured(),
    // The select mirrors the persisted source (and a drafted Homey Energy
    // switch, where the picker hint is exactly right).
    source,
    meterChosen: hasChosenWholeHomeMeter(),
    meterName: getChosenWholeHomeMeterName(),
  });
  // The setup path's Power meter step says this same sentence where it stands
  // in for the banner, so it is handed the banner's words rather than its own.
  publishSetupPower(readings.state === 'never'
    ? { state: 'never', remedy: content?.text ?? NO_READINGS_YET_FALLBACK }
    : { state: 'received' });
  if (!staleDataBanner) return;
  staleDataBanner.hidden = content === null || isNoReadingsCarriedBySetupPath(knownSingleHome);
  if (content === null) return;
  if (staleDataBannerText) staleDataBannerText.textContent = content.text;
  if (staleDataBannerAction) {
    staleDataBannerAction.textContent = content.actionLabel;
    staleDataBannerAction.dataset.settingsAnchor = readings.state === 'received' && source === 'homey_energy'
      ? '#settings-homey-energy-meter' : '#settings-power-source';
  }
};
