import type { OverviewDeviceRowsRead } from './overviewDeviceRows.ts';
import { resolveControlContestRecommendations, type SetupRecommendation } from './recommendationsModel.ts';

type RecommendationDismissal = 'loading' | 'unavailable' | 'active' | 'dismissed';

/** The acknowledgement owner registers here without importing the Overview renderer. */
type RecommendationDismissals = {
  read: (recommendation: SetupRecommendation) => RecommendationDismissal;
  dismiss: (recommendation: SetupRecommendation) => Promise<void>;
};

export type OverviewControlWarning = {
  recommendation: SetupRecommendation;
  onDismiss?: () => Promise<void>;
};

let dismissals: RecommendationDismissals | undefined;

export const registerOverviewRecommendationDismissals = (owner: RecommendationDismissals): void => {
  dismissals = owner;
};

/** Resolve warnings from the displayed home's roster, including devices without a plan. */
export const resolveOverviewControlWarnings = (
  roster: OverviewDeviceRowsRead,
): ReadonlyMap<string, OverviewControlWarning> => {
  const warnings = new Map<string, OverviewControlWarning>();
  const owner = dismissals;
  if (!owner || roster.state !== 'resolved') return warnings;
  for (const { device } of roster.rows) {
    const recommendation = resolveControlContestRecommendations([device])[0];
    if (!recommendation) continue;
    const dismissal = owner.read(recommendation);
    if (dismissal === 'loading' || dismissal === 'dismissed') continue;
    warnings.set(device.id, {
      recommendation,
      ...(dismissal === 'active' ? { onDismiss: () => owner.dismiss(recommendation) } : {}),
    });
  }
  return warnings;
};
