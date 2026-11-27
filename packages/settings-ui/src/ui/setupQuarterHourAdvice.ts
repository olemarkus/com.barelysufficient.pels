import { readActiveRecommendation, dismissSetupRecommendation } from './recommendations.ts';
import { readSetupIntent } from './setupIntent.ts';
import type { SetupJourneyStep } from './setupJourneyState.ts';
import { readSetupCapacityLimit } from './setupPathFacts.ts';
import type { SetupJourneyHeaderProps } from './views/SetupJourney.tsx';

export const readSetupQuarterHourAdvice = (step: SetupJourneyStep, repaint: () => void): Pick<
  SetupJourneyHeaderProps, 'quarterHourAdvice' | 'onDismissQuarterHour'
> => {
  if (step !== 'hardCap') return { quarterHourAdvice: null, onDismissQuarterHour: null };
  if (readSetupIntent() === 'quarter-hour' && readSetupCapacityLimit()?.periodMinutes === 60) {
    return {
      quarterHourAdvice: 'If your tariff charges for your highest 15-minute average, choose that period here.',
      onDismissQuarterHour: null,
    };
  }
  const advice = readActiveRecommendation('market:flanders-capacity-period');
  return {
    quarterHourAdvice: advice?.body ?? null,
    onDismissQuarterHour: advice ? () => { void dismissSetupRecommendation(advice).then(repaint); } : null,
  };
};
