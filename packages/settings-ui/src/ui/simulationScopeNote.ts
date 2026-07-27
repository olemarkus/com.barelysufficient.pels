import { HOME_SCOPE_SIMULATION_MAIN_ONLY_NOTE } from '../../../shared-domain/src/homeScopeCopy.ts';
import { simulationHomeScopeNote } from './dom.ts';

/**
 * Honest scope note on the Simulation-mode settings page (multi-home): the
 * page carries only the Main home's switch, yet the Settings hub's "Partly
 * on" chip routes there for any split posture — so once at least one ACTIVE
 * meter area exists, the page names where each area's own control lives.
 * Driven from `capacity.ts`'s `syncDryRunBannerVisibility`, whose callers
 * already cover every input the note depends on (the active-area roster);
 * the note is static per posture, not per flag value.
 */
export const syncSimulationHomeScopeNote = (hasActiveMeterAreas: boolean): void => {
  if (!simulationHomeScopeNote) return;
  if (hasActiveMeterAreas) simulationHomeScopeNote.textContent = HOME_SCOPE_SIMULATION_MAIN_ONLY_NOTE;
  simulationHomeScopeNote.hidden = !hasActiveMeterAreas;
};
