# Multi-home: main is the membership complement

Design-of-record for the R5 slice of the multi-home train — the first
behavior-affecting membership consumer. Documents what ships in
`feat(plan): main plan input becomes the membership complement`, not the
per-home bundles that follow. For the full v1 model (home identity, suffix
scheme, per-home bundles, upgrade activation containment) see
[multi-home-model](multi-home-model.md).

## Rule of record

- A device belongs to the DEEPEST sub-home whose root-zone subtree contains its
  Homey zone; outside every sub-home it belongs to the implicit main home
  (`lib/home/membership.ts`). An explicit pin overrides the zone rule; pinning
  to `'main'` opts a device out of a surrounding sub-home.
- Main's planner and sample accounting consume the COMPLEMENT: with sub-homes
  configured, sub-home members are excluded from main's plan input
  (`setup/homeRuntime/homeScope.ts`) and from the sample-pipeline snapshot view
  (`setup/homeRuntime/createHomePowerPipeline.ts`) through one shared seam,
  `filterDevicesForHome` (`setup/homeMembership.ts`). The same seam removes
  every configured Main/sub-home meter because meter identity is source
  ownership, independent of zone or pin membership. Those persisted selections
  are dormant when Flow is the active whole-home power source. The filter
  consumes only the provenance-free `HomeMembershipPort` slice — never
  membership `source`.
  If Main-meter authority is transiently unavailable, the producer retains its
  last-good source identity and every home's filter/actuator fails closed.
- Identity guard: with no sub-homes and no explicit Main meter (or the service
  unwired), the filter returns the same array reference. A resolved explicit
  Main meter is deliberately removed because source devices are never
  controllable loads.

## Historical fail-safe intermediate state (closed at R7b)

Before the per-home bundles landed, a sub-home member was simply UNCONTROLLED
— never double-controlled. Nothing planned it, shed it, or counted it as
managed load; its draw landed in main's background usage. R7b closed this
intermediate state by giving each configured meter area its own capacity
bundle.

## Combined-meter fallback accounting

With one whole-home meter, main's capacity/daily budgets are enforced against
a total that INCLUDES sub-home draw main cannot control. The failure direction
is safe but conservative:

- Sub-home draw pushes main over its budget → main sheds its OWN devices.
- A sub-home-only overshoot (main has nothing left to shed) is an unwinnable
  plan; the rebuild anti-storm guards absorb it (unactionable plans throttle to
  the max-interval cadence — `lib/plan/planLogging.ts` /
  `setup/powerSamplePipeline.ts`) rather than storming rebuilds.

One-interval attribution drift is possible by design: the sample pipeline
captures its filtered snapshot when the sample arrives, while the rebuild it
queues re-filters independently — a membership recompute landing between those
two reads can skew ONE interval's controlled/background attribution, and the
next sample self-heals it.

The remedy for a genuinely two-meter home is the explicit meter picker:
`homey_energy_meter_device_id` points main's `homey_energy` sampling at main's
own meter device (absent = Homey's marked whole-home cumulative item). Once a
sub-home exists, selecting main's own meter is REQUIRED for correct main-side
accounting; the whole-home default keeps the conservative behavior above.

## Boot window and zone retention

- The zone tree rides a detached fetch; before ANY tree is seen, zone-rule
  devices resolve to main (`source: 'fallback'`) — the acceptable boot state.
  With active sub-homes that resolution is diagnostic/provisional, not write
  authority: the producer-owned Main fence blocks both plan-executor and
  terminal smart-task actuation, while each sub-home bundle stays gated too.
  The tree-commit trigger recomputes membership and opens the correctly owned
  write seams as soon as the fetch lands.
- A fulfilled snapshot whose device entry transiently omits its zone does NOT
  flap the device to main for one cycle: `HomeMembershipService` retains the
  last-known zoneId per device (pruned when the device genuinely leaves the
  snapshot; follows zone moves; edge-triggered debug log
  `home_membership_zone_retained`).

## Shed-then-moved devices: adopted by the sub-home bundle (closed at R7b)

A device shed by main that THEN joins a sub-home drops out of main's plan
input; from R7b the sub-home's own capacity bundle
(`setup/homeRuntime/createHomeCapacityBundle.ts`) plans it, and the generic
provenance-free restore lanes (`lib/plan/restore/devices.ts` — candidacy is
observed-state-only, no shed-provenance fields) resume it when headroom
allows. Verified per modality: the binary adoption path runs end-to-end in
`test/e2e/homeCapacityBundlesSdkE2E.test.ts` (main sheds → sub-home bundle
resumes); binary + stepped candidate lanes are pinned in
`test/integration/homeCapacityBundles.test.ts`.
