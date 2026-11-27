import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUi/webApp.ts';
import { getSettingFresh, setSetting } from './homey.ts';
import type { SetupGoalChoice, SetupGoalChoices } from './setupGoals.ts';

const SETUP_INTENT_KEY = 'setup_intent';
export const SETUP_INTENT_CHANGED = 'pels:setup-intent-changed';
const INTENTS = ['solar', 'battery', 'quarter-hour', 'general'] as const;
export type SetupIntent = typeof INTENTS[number];

export const SETUP_INTENT_LABELS: Record<SetupIntent, string> = {
  solar: 'Use spare solar',
  battery: 'Coordinate my home battery',
  'quarter-hour': 'Limit quarter-hour peaks',
  general: 'Continue with general setup',
};

export const setupIntentOptions = (market: SettingsUiHubMarketRead): readonly SetupIntent[] => (
  market.state === 'resolved' && market.country === 'BE'
    ? ['quarter-hour', 'solar', 'battery', 'general'] : INTENTS
);

let choice: SetupIntent | null | undefined;
let pendingRead: Promise<boolean> | null = null;
let generation = 0;

export const readSetupIntent = (): SetupIntent | null => choice ?? null;

const publish = (next: SetupIntent | null): void => {
  if (choice === next) return;
  choice = next;
  document.dispatchEvent(new Event(SETUP_INTENT_CHANGED));
};

const refreshSetupIntent = (): Promise<boolean> => {
  const current = ++generation;
  pendingRead = getSettingFresh(SETUP_INTENT_KEY).then((raw) => {
    if (current === generation) publish(INTENTS.find((intent) => raw === intent) ?? null);
    return choice !== undefined;
  }, () => choice !== undefined).finally(() => {
    if (current === generation) pendingRead = null;
  });
  return pendingRead;
};

/** Share the boot read with early first-run navigation and retry an unavailable read on entry. */
export const loadSetupIntent = (): Promise<boolean> => (
  choice !== undefined ? Promise.resolve(true) : pendingRead ?? refreshSetupIntent()
);

export const reloadSetupIntentIfChanged = (key: string): void => {
  if (key === SETUP_INTENT_KEY) void refreshSetupIntent();
};

export const saveSetupIntent = async (intent: SetupIntent): Promise<void> => {
  await setSetting(SETUP_INTENT_KEY, intent);
  publish(intent);
  // A read that began before this accepted save cannot restore an old answer.
  // Re-read if one was in flight, so another WebView's newer write still wins.
  if (pendingRead !== null) void refreshSetupIntent();
};

export const prioritizeSetupGoalChoices = (choices: SetupGoalChoices, intent: SetupIntent | null): SetupGoalChoices => {
  if (choices.state !== 'ready' || (intent !== 'solar' && intent !== 'battery')) return choices;
  const matches = (device: SetupGoalChoice): boolean => (
    intent === 'solar' ? device.solar !== null : device.battery !== null
  );
  return {
    ...choices,
    devices: [...choices.devices].sort((left, right) => Number(matches(right)) - Number(matches(left))),
  };
};
