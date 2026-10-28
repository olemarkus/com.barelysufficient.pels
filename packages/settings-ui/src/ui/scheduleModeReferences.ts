import type { ScheduleEntry } from '../../../contracts/src/schedules.ts';

type ModeReferences = Readonly<ScheduleEntry['modeReferences']>;
export type ScheduleModeOption = { value: string; label: string };

/** Labels are owner-resolved; values keep the retained name understood by the mode owner. */
export const scheduleModeLabel = (stored: string, references: ModeReferences): string => (
  references.find((reference) => reference.stored === stored)?.resolved ?? stored
);

export const scheduleModeOptions = (
  modes: readonly string[],
  references: ModeReferences,
): ScheduleModeOption[] => {
  const retained = new Map(references.map((reference) => [reference.stored, reference]));
  const current = modes.filter((mode) => !retained.has(mode))
    .map((mode) => ({ value: mode, label: mode }));
  return [...current, ...Array.from(retained.values(), (reference) => ({
    value: reference.stored, label: `${reference.resolved} (saved as ${reference.stored})`,
  }))];
};

export const isScheduleModeAvailable = (
  stored: string,
  modes: readonly string[],
  references: ModeReferences,
): boolean => modes.includes(stored) || references.some((reference) => reference.stored === stored);
