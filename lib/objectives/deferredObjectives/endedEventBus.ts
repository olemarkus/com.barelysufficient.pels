import type {
  DeferredObjectivePlanOutcome,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveSettingsKind } from '../../../packages/contracts/src/deferredObjectiveSettings';

// Public outcomes exposed to Flow automations. Maps from the broader internal
// outcome set (`planHistory.ts`):
//   met       → succeeded
//   missed    → missed
//   abandoned → abandoned
//   replaced  → suppressed (the task continues under a new deadline; firing
//               an "ended" trigger here would surprise users)
//   unknown   → suppressed (no actionable signal)
export type DeferredObjectivePublicOutcome = 'succeeded' | 'missed' | 'abandoned';

export type DeferredObjectiveEndedEvent = {
  deviceId: string;
  // The name the recorder last saw, or the device id when it never saw one
  // (`finalizeRecord`).
  deviceName: string;
  objectiveKind: DeferredObjectiveSettingsKind;
  outcome: DeferredObjectivePublicOutcome;
  // Unit-agnostic deadline target (°C for temperature, % for EV SoC — disambiguate
  // via `objectiveKind`). Resolved from the entry's kind-split columns at build
  // time so consumers never branch on kind to pick the value.
  targetValue: number | null;
  deadlineAtMs: number;
  finalizedAtMs: number;
  // Only populated when outcome === 'succeeded'.
  metAtMs: number | null;
  // Unit-agnostic final progress reading (same unit rule as `targetValue`).
  finalProgressValue: number | null;
};

type Listener = (event: DeferredObjectiveEndedEvent) => void;

export type DeferredObjectiveEndedBus = {
  publish: (event: DeferredObjectiveEndedEvent) => void;
  onEnded: (listener: Listener) => () => void;
};

export const createDeferredObjectiveEndedBus = (): DeferredObjectiveEndedBus => {
  const listeners = new Set<Listener>();
  return {
    publish: (event) => {
      for (const listener of listeners) listener(event);
    },
    onEnded: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

// Maps an internal outcome to its public Flow-trigger value, or `null` when
// the outcome should not fire the trigger (`replaced`, `unknown`).
export const toPublicOutcome = (
  outcome: DeferredObjectivePlanOutcome,
): DeferredObjectivePublicOutcome | null => {
  switch (outcome) {
    case 'met': return 'succeeded';
    case 'missed': return 'missed';
    case 'abandoned': return 'abandoned';
    case 'replaced':
    case 'unknown':
      return null;
    default: {
      // Exhaustiveness guard: a new DeferredObjectivePlanOutcome member must
      // decide here whether it fires the public "ended" trigger. Suppresses
      // (null) any out-of-schema persisted outcome rather than throwing.
      const exhaustive: never = outcome;
      void exhaustive;
      return null;
    }
  }
};

export const buildEndedEventFromEntry = (
  entry: ResolvedDeferredObjectivePlanHistoryEntry,
): DeferredObjectiveEndedEvent | null => {
  // Backfill entries describe deadlines that elapsed before PELS observed
  // them — firing a Flow trigger retroactively would be surprising.
  if (entry.discoveredFrom === 'backfill') return null;
  const publicOutcome = toPublicOutcome(entry.outcome);
  if (publicOutcome === null) return null;
  return {
    deviceId: entry.deviceId,
    deviceName: entry.deviceName,
    objectiveKind: entry.objectiveKind,
    outcome: publicOutcome,
    targetValue: entry.targetValue,
    deadlineAtMs: entry.deadlineAtMs,
    finalizedAtMs: entry.finalizedAtMs,
    metAtMs: entry.metAtMs,
    finalProgressValue: entry.finalProgressValue,
  };
};
