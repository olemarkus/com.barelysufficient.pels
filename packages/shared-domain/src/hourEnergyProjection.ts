// Projected end-of-hour energy from the live draw: what this hour lands at if
// the current power holds. Floored at zero — in a net-export hour the raw
// projection can go negative, and every consumer treats "projected" as a
// used-energy figure (see `planHeroSummary.formatProjectedEnergySubline` and
// the plan_budget widget clamp). Shared between the Overview hero
// (`PlanHero.tsx` energy bar) and the `pels_status` producer
// (`lib/plan/pelsStatus.ts`) so the "Above hard cap" trajectory judgement
// shares one formula AND one predicate across surfaces. (The two sides still
// evaluate slightly different inputs — the hero reads the rounded plan
// snapshot, the producer raw meta — so near-boundary flicker is possible;
// tracked in TODO.md.)
//
// Own module (not `planHeroSummary.ts`): the runtime imports this, and the
// hero-summary module uses settings-ui-style `.ts`-suffixed imports the root
// tsconfig rejects — keeping the shared math dependency-free avoids coupling
// the runtime to the UI formatting stack.
export const computeProjectedHourEnergyKWh = (params: {
  usedKWh: number;
  totalKw: number;
  minutesRemainingInHour: number;
}): number => Math.max(0, params.usedKWh + (params.totalKw * params.minutesRemainingInHour) / 60);

// THE "Above hard cap" judgement: is this hour on pace to land past the cap's
// hourly kWh? Strict `>` (a projection exactly at the cap holds the step), and
// `false` whenever no cap value is known — an absent cap must never escalate,
// on any surface. Both the hero's projection tone and the `pels_status`
// producer call this predicate so the verdict cannot fork.
export const isProjectedOverHardCap = (params: {
  projectedKWh: number;
  hardCapKWh: number | null | undefined;
}): boolean => typeof params.hardCapKWh === 'number' && params.projectedKWh > params.hardCapKWh;
