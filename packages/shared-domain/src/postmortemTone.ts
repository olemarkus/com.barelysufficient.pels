// Map a price-store entry's already-resolved `isCheap`/`isExpensive`
// flags onto the postmortem tone enum used by the deferred-objective
// hour-rollover detector and price-strip surfaces.
//
// Consuming the producer's classification directly (per
// `feedback_layering_resolution_in_producer`) keeps the postmortem tone
// in lockstep with the live price chip — same flag set, same min-diff,
// same thresholds — with no re-derivation and no drift.
//
// Lives in shared-domain so the postmortem strip and the live price
// chip share one classification surface.

export type PostmortemTone = 'cheap' | 'normal' | 'expensive';

export type PostmortemToneInput = {
  isCheap?: boolean;
  isExpensive?: boolean;
};

export const resolvePostmortemTone = (entry: PostmortemToneInput): PostmortemTone => {
  if (entry.isCheap) return 'cheap';
  if (entry.isExpensive) return 'expensive';
  return 'normal';
};
