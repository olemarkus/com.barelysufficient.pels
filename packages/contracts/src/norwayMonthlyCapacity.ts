/** Monthly Norwegian capacity evidence resolved by the power owner. */
export type NorwayCapacityDailyPeak = {
  readonly dateKey: string;
  readonly hourStartMs: number;
  readonly kw: number;
  /** Current-hour import is a lower bound until that hour completes. Never persisted as a completed peak. */
  readonly lowerBound?: true;
};

/** Remaining-month bounded guidance is the actual hourly hard cap; the safety margin stays below it.
 * `keep_current` names the unchanged hard cap instead, while the tier loss buffer settles.
 */
export type NorwayRemainingMonthCap =
  | { readonly state: 'bounded'; readonly limitKw: number }
  | { readonly state: 'keep_current'; readonly limitKw: number }
  | { readonly state: 'unbounded_tier' }
  | { readonly state: 'no_positive_limit' };

/** Concrete hourly hard-cap setting; the existing margin is reserved below this limit. */
export type NorwayHardCapRecommendation =
  | { readonly state: 'set' | 'keep'; readonly limitKw: number; readonly marginKw: number }
  | { readonly state: 'none' };

export type NorwayMonthlyCapacityRead =
  | { readonly state: 'hidden' }
  | { readonly state: 'unavailable'; readonly reason: 'grid_company' | 'tariff' | 'timezone' }
  | {
    readonly state: 'ready';
    readonly monthKey: string;
    readonly tariffIdentity: string;
    readonly coverage: 'complete' | 'partial';
    readonly peaks: readonly NorwayCapacityDailyPeak[];
    readonly average: { readonly state: 'collecting'; readonly days: number }
      | { readonly state: 'recorded'; readonly kw: number };
    readonly tier: { readonly lowerKw: number; readonly upperKw: number | null };
    readonly targetBoundaryKw: number | null;
    readonly targetLost: boolean;
    readonly remainingMonthCap: NorwayRemainingMonthCap;
    readonly hardCapRecommendation: NorwayHardCapRecommendation;
    readonly advice: { readonly state: 'none' }
      | {
        readonly state: 'suggestion';
        /** The actual hourly hard cap. The safety margin is subtracted below this setting. */
        readonly limitKw: number; readonly version: string;
        readonly direction: 'raise' | 'lower'; readonly actionable: boolean;
      };
  };

export type NorwayCapacityChoiceOffer = {
  monthKey: string;
  tariffIdentity: string;
  /** Accepted hourly hard cap; the safety margin remains reserved below it. */
  limitKw: number;
  revision: string;
};
export type NorwayCapacityChoiceState =
  | { state: 'normal' }
  | { state: 'active'; offer: NorwayCapacityChoiceOffer; normalLimitKw: number };
export type NorwayCapacityChoiceOutcome =
  | { state: 'idle' }
  | { state: 'accepted' | 'rejected'; requestId: string; message: string };
