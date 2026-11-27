import { h, render } from 'preact';
import { settingsPowerSourceSelect } from './dom.ts';
import { currentSetupJourney } from './setupJourneyState.ts';
import {
  loadSetupIntent, readSetupIntent, saveSetupIntent, setupIntentOptions, type SetupIntent,
} from './setupIntent.ts';
import { readSetupMarket, readSetupReview } from './setupPathFacts.ts';
import { nextSetupStep, type SetupStep } from './setupPathModel.ts';
import { resolveSolarSurplusPending, resolveSolarSurplusPendingNote } from './state.ts';
import { navigateBackToShellOrigin, replaceTab, showTab } from './tabNavigation.ts';
import { SetupIntentQuestion } from './views/SetupIntentQuestion.tsx';

const firstSetupStep = (): SetupStep | undefined => {
  const path = readSetupReview();
  if (!path?.simulating) return undefined;
  const next = nextSetupStep(path);
  return next?.id === 'power' || next?.id === 'devices' ? next : undefined;
};

/** The setup card's first pending meter or device step can offer one optional question before navigation. */
export const openFirstSetupStep = async (target: string, step: 'power' | 'devices'): Promise<void> => {
  const origin = window.location.href;
  const loaded = await loadSetupIntent();
  if (window.location.href !== origin) return;
  if (loaded && readSetupIntent() === null && firstSetupStep()?.id === step) {
    showTab('setup-review', 'intent');
  } else showTab(target, step);
};

export const saveAndContinueSetupIntent = async (intent: SetupIntent): Promise<void> => {
  await saveSetupIntent(intent);
  if (currentSetupJourney() !== 'intent') return;
  const next = firstSetupStep();
  if (next) replaceTab(next.target.panel, next.id);
  else navigateBackToShellOrigin('recommendations');
};

export const paintSetupIntentQuestion = (
  busy: boolean, error: string | null, onChoose: (intent: SetupIntent) => void,
): void => {
  const root = document.getElementById('setup-review-root');
  if (!root) return;
  const solarNote = resolveSolarSurplusPending()
    ? resolveSolarSurplusPendingNote(settingsPowerSourceSelect?.value === 'flow') : null;
  render(h(SetupIntentQuestion, {
    options: setupIntentOptions(readSetupMarket()),
    selected: readSetupIntent(),
    solarNote,
    busy,
    error,
    onChoose,
    onBack: () => navigateBackToShellOrigin('recommendations'),
  }), root);
};
