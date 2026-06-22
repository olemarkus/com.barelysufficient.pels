/**
 * Single source of truth for the managed (controlled) vs background (uncontrolled)
 * ATTRIBUTION split of a bucket's ACTUAL consumption.
 *
 * Prefers the producer-resolved GROSS uncontrolled bucket so the split reflects true
 * background load, not the net grid total reduced by self-consumed solar. Gross
 * controlled + uncontrolled = gross consumption and may exceed the net total under PV,
 * so the split is NOT clamped to the net total. When no gross uncontrolled bucket exists
 * (legacy persisted state) it falls back to deriving the split from the net total.
 *
 * This is attribution only — consumed by the Power view, the daily-budget breakdown view,
 * the learned-profile weights, and the observed reserve floors. Budget PACING
 * (`budgetControlUsedNowKWh = net total − exempt`) and the capacity cap read the NET total
 * directly and never go through this split. Keeping the rule in one place stops the four
 * former copies from drifting (and from re-clamping gross data back to net).
 */
export const resolveAttributionSplit = (params: {
  /** Net grid total for the bucket (kWh). Negative inputs are floored to 0. */
  totalNet: number;
  /** Gross managed device draw (kWh), or undefined when no controlled bucket exists. */
  controlledGross?: number;
  /** Gross background (kWh), or undefined when no uncontrolled bucket exists. */
  uncontrolledGross?: number;
  /** Budget-exempt managed draw (kWh), subtracted from the controlled side. */
  exemptGross?: number;
}): { controlled: number | null; uncontrolled: number | null } => {
  const { totalNet, controlledGross, uncontrolledGross, exemptGross } = params;
  const total = Number.isFinite(totalNet) ? Math.max(0, totalNet) : 0;
  const hasControlled = typeof controlledGross === 'number' && Number.isFinite(controlledGross);
  const hasUncontrolled = typeof uncontrolledGross === 'number' && Number.isFinite(uncontrolledGross);
  if (!hasControlled && !hasUncontrolled) return { controlled: null, uncontrolled: null };
  const exempt = typeof exemptGross === 'number' && Number.isFinite(exemptGross)
    ? Math.max(0, exemptGross)
    : 0;

  if (hasUncontrolled) {
    // Exempt load (budget-exempt managed draw) is reserved on the uncontrolled/background
    // side of the budget breakdown — matching the legacy net split — so it is removed from
    // controlled and folded into uncontrolled rather than dropped.
    const uncontrolled = Math.max(0, uncontrolledGross as number) + exempt;
    const controlled = hasControlled
      ? Math.max(0, (controlledGross as number) - exempt)
      : Math.max(0, total - uncontrolled);
    return { controlled, uncontrolled };
  }

  // Legacy state without a persisted gross uncontrolled bucket: derive from the net total.
  const boundedExempt = Math.min(exempt, total);
  const controlled = Math.max(0, Math.min((controlledGross as number) - boundedExempt, total));
  return { controlled, uncontrolled: Math.max(0, total - controlled) };
};
