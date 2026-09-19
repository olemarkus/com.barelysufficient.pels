// Projected end-of-period billed import from the live draw: what the capacity
// period (hour or quarter) lands at if the current power holds. Export contributes zero, matching the
// import-only tracker; it cannot subtract energy already billed. The result is
// also floored at zero because every consumer treats "projected" as a used-
// energy figure (see `planHeroSummary.formatProjectedEnergySubline`). Shared
// between the Overview hero
// (`PlanHero.tsx` energy bar) and the `pels_status` producer
// (`lib/plan/pelsStatus.ts`) so the "Above hard cap" trajectory judgement
// shares one formula AND one predicate across surfaces. (The two sides still
// evaluate slightly different inputs — the hero reads the rounded plan
// snapshot, the producer raw meta — so near-boundary flicker is possible.)
//
// Own module (not `planHeroSummary.ts`): the runtime imports this, and the
// hero-summary module uses settings-ui-style `.ts`-suffixed imports the root
// tsconfig rejects — keeping the shared math dependency-free avoids coupling
// the runtime to the UI formatting stack.
export const computeProjectedPeriodEnergyKWh = (
  usedKWh: number,
  totalKw: number,
  minutesRemaining: number,
): number => Math.max(0, usedKWh + (Math.max(0, totalKw) * minutesRemaining) / 60);

// THE "Above hard cap" judgement: is this period on pace to land past the cap's
// period kWh? Strict `>` (a projection exactly at the cap holds the step), and
// `false` whenever no cap value is known — an absent cap must never escalate,
// on any surface. Both the hero's projection tone and the `pels_status`
// producer call this predicate so the verdict cannot fork.
export const isProjectedOverHardCap = (params: {
  projectedKWh: number;
  hardCapKWh: number | null | undefined;
}): boolean => typeof params.hardCapKWh === 'number' && params.projectedKWh > params.hardCapKWh;
