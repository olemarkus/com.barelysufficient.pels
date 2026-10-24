/** Browser navigation and pending setup saves; never persisted as completion. */
export const SETUP_JOURNEY_STEPS = ['power', 'devices', 'solar', 'hardCap', 'prices', 'review'] as const;
export type SetupJourneyStep = typeof SETUP_JOURNEY_STEPS[number];

export const setupJourneyFromSearch = (search: string): SetupJourneyStep | null => {
  const value = new URLSearchParams(search).get('setup');
  return SETUP_JOURNEY_STEPS.find((step) => step === value) ?? null;
};

export const currentSetupJourney = (): SetupJourneyStep | null => setupJourneyFromSearch(window.location.search);

const pending = new Set<Promise<unknown>>();
type SetupSaveKey = string | symbol;
const failures = new Set<SetupSaveKey>();
const latest = new Map<SetupSaveKey, Promise<unknown>>();
const changed = (): void => { document.dispatchEvent(new Event('pels:setup-save')); };

export const setupSavePending = (): boolean => pending.size > 0;

export const acknowledgeSetupSaveFailures = (): void => { failures.clear(); };

export const trackSetupSave = async <T>(key: SetupSaveKey, save: () => Promise<T>): Promise<T> => {
  failures.delete(key);
  const operation = Promise.resolve().then(save);
  pending.add(operation);
  latest.set(key, operation);
  changed();
  try {
    return await operation;
  } catch (error) {
    if (latest.get(key) === operation && currentSetupJourney()) failures.add(key);
    throw error;
  } finally {
    pending.delete(operation);
    if (latest.get(key) === operation) latest.delete(key);
    changed();
  }
};

export const waitForSetupSaves = async (): Promise<void> => {
  while (pending.size > 0) await Promise.allSettled([...pending]);
  if (failures.size > 0) {
    failures.clear();
    throw new Error('A setting could not be saved. Check the change before continuing.');
  }
};

export const isSolarSetupJourney = (): boolean => currentSetupJourney() !== null
  && (currentSetupJourney() === 'solar' || new URLSearchParams(window.location.search).get('setupGoal') === 'solar');
