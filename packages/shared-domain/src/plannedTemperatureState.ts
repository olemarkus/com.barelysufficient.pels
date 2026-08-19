/**
 * The complete temperature state of a temperature device once the planner has
 * decided: the observer's atomic pair plus the planner's commanded setpoint.
 *
 * **Ownership is the planner's.** `lib/observer` owns the pair one layer down
 * (`ObservedTemperatureState` — `currentTemperature` + `currentTarget`, admitted
 * atomically or not at all); `plannedTarget` is the planner's own decision, and
 * the observer deliberately has no opinion about it. This shape lives in
 * `shared-domain` only because that is the lowest layer both `lib/plan` and the
 * settings UI may import — not because either of them owns it.
 *
 * It is deliberately named after neither consumer, because it has two: it is
 * simultaneously the planner's temperature cluster (`TemperatureKind` in
 * `lib/plan/planTypes.ts`, a member of the `DevicePlanDevice` discriminated
 * union) and the shape a temperature device's overview card renders from
 * (`DeviceOverviewSnapshot.temperature`). A field added here to serve one of
 * those lands on the other — where, on the planner side, it widens what
 * `isTemperaturePlanDevice` narrows to. Add nothing only one side can justify;
 * if the two shapes ever genuinely diverge, split them and take the duplication
 * (root `AGENTS.md`, "accept code duplication if consolidation would violate an
 * architectural boundary") rather than growing a union that serves neither.
 *
 * **Invariant, identical on both sides: all three values are finite numbers
 * wherever this shape exists.** The runtime producer
 * (`lib/plan/planOverviewTemperatureState`) resolves it from an atomic observer
 * facet plus the planner's decision. The WebView adapter
 * (`packages/settings-ui/src/ui/planSnapshotParse`) re-establishes it once on
 * the untrusted side of the API transport, dropping a malformed facet whole
 * rather than repairing it — a device with junk temperature renders as its
 * non-temperature variant. Inward of either producer, consumers read the three
 * numbers directly and must not re-check finiteness.
 */
export type PlannedTemperatureState = {
  currentTarget: number;
  currentTemperature: number;
  plannedTarget: number;
};
