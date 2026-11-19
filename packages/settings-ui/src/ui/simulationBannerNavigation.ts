import { readSimulationBannerAreaId, refreshDryRunBannerHomeScope } from './capacity.ts';
import { getHomeScope, refreshHomeScope, selectHomeScope } from './homeScope.ts';
import { scrollSettingsAnchorWhenVisible } from './settingsAnchor.ts';
import { showTab } from './tabNavigation.ts';
import { showToast } from './toast.ts';

export const initAreaSimulationBannerNavigation = (
  button: HTMLElement,
  openMainReview: () => void,
): void => {
  let navigation = 0;
  let opening = false;
  document.addEventListener('pels:tab-shown', () => { navigation += 1; });

  button.addEventListener('click', async () => {
    if (opening) return;
    const areaId = readSimulationBannerAreaId();
    if (areaId === null) { openMainReview(); return; }
    const origin = navigation;
    // A first successful roster read may restore another saved area. Only
    // navigation or a changed banner target supersedes the pending tap.
    const stillOnOrigin = () => origin === navigation && readSimulationBannerAreaId() === areaId;
    const knowsArea = () => getHomeScope().areas.some((area) => area.homeId === areaId);
    opening = true;
    try {
      // The banner uses saved area settings. The scope switcher reads the Homey
      // roster independently and may still need to load the named area.
      if (!knowsArea()) await refreshHomeScope();
      if (!stillOnOrigin()) return;
      if (!knowsArea()) {
        // A deleted or newly enabled area drops off the banner on this read.
        await refreshDryRunBannerHomeScope();
        if (stillOnOrigin()) void showToast('Could not open this meter area. Try again.', 'warn');
        return;
      }
      selectHomeScope(areaId);
      showTab('limits');
      const destination = navigation;
      scrollSettingsAnchorWhenVisible(
        `#home-limits-mount[data-home-id="${CSS.escape(areaId)}"] #home-limits-simulation-row`,
        () => destination === navigation && getHomeScope().selectedHomeId === areaId
          && readSimulationBannerAreaId() === areaId,
      );
    } finally {
      opening = false;
    }
  });
};
