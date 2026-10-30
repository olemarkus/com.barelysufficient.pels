import type { RecommendationTarget } from './recommendationsModel.ts';
import type { SetupJourneyStep } from './setupJourneyState.ts';
import { checkFlowConflictNow, hasEvSocFlowReporter, refreshFlowConflictFactsExplicit } from './flowConflictRefresh.ts';
import { state } from './state.ts';
import { showToast } from './toast.ts';

export type RecommendationNavigation = {
  openPanel: (panelId: string, setup?: SetupJourneyStep) => void;
  useQuarterHour: () => Promise<void>;
  openDevice: (deviceId: string, focus: 'top' | 'start-policy' | 'shed-limit') => void;
};

type RecommendationTask = { run: () => Promise<void>; failureMessage: string };

export const resolveRecommendationTask = (
  target: RecommendationTarget,
  navigation: RecommendationNavigation | null,
): RecommendationTask | null => {
  if (target.kind === 'quarter-hour' && navigation) {
    return { run: navigation.useQuarterHour, failureMessage: 'Could not save the capacity period.' };
  }
  if (target.kind === 'flow-conflict-check') {
    return {
      run: async () => {
        const conflict = await checkFlowConflictNow(target.deviceId);
        await showToast(
          conflict ? 'PELS still finds Flow control for this device.' : 'No conflicting Flow control found.',
          conflict ? 'warn' : 'ok',
        );
      },
      failureMessage: 'Could not check Homey Flows. Try again.',
    };
  }
  if (target.kind === 'ev-soc-flow-conflict-check') {
    return {
      run: async () => {
        await refreshFlowConflictFactsExplicit();
        const selectedCar = (state.evCarAssociations[target.deviceId]?.carIds.length ?? 0) > 0;
        const conflict = selectedCar && hasEvSocFlowReporter(target.deviceId);
        await showToast(
          conflict ? 'PELS still finds battery reporting for this charger.' : 'No unused battery reporting found.',
          conflict ? 'warn' : 'ok',
        );
      },
      failureMessage: 'Could not check Homey Flows. Try again.',
    };
  }
  return null;
};
