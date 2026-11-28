/**
 * What the Modes order decides for the home, which the optional setup step
 * `priorities` names. While a limit is in force, or the limits are still being
 * read (`limitsInForce === null`), the order decides which device stays on
 * longest. With no limit it decides only which device gets spare solar first,
 * and in a home without solar nothing at all: setup then skips the step, and the
 * order stays available in Modes.
 */
export type SetupPriorityFraming = 'limit' | 'solar' | 'none';

export const resolveSetupPriorityFraming = (
  limitsInForce: boolean | null,
  homeHasSolar: boolean,
): SetupPriorityFraming => {
  if (limitsInForce !== false) return 'limit';
  return homeHasSolar ? 'solar' : 'none';
};

export const setupPriorityTitle = (framing: SetupPriorityFraming): string => (
  framing === 'solar' ? 'Choose what gets spare solar first' : 'Choose what stays on longest'
);

export const setupPriorityDetail = (
  framing: SetupPriorityFraming,
  modeName: string,
  batteryPlansOn: number,
): string => `Optional. In ${modeName}, `
  + (framing === 'solar' ? 'the top device gets spare solar first. ' : 'the top device keeps running longest. ')
  + (batteryPlansOn >= 2 ? 'Batteries higher in the list are also planned first. ' : '')
  + 'Drag to change the order, or continue with the current order. You can change it later in Modes.';
