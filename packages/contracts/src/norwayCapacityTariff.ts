/** Three distinct daily maxima, each measured over one clock hour, in a local calendar month. */
export type NorwayCapacityTariff = {
  readonly identity: string;
  /** Sorted tier lower bounds, starting at zero. */
  readonly boundariesKw: readonly number[];
  /** A value equal to a boundary belongs to the tier beginning there. */
  readonly thresholdIncluded: boolean;
};

/** Capacity tariff facts resolved by the price owner for the requested billing month. */
export type NorwayCapacityTariffRead =
  | { readonly state: 'supported'; readonly tariff: NorwayCapacityTariff }
  | { readonly state: 'unsupported'; readonly reason: string }
  | { readonly state: 'unavailable'; readonly reason: string };
