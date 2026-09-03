# Device Layer — Orientation and State Invariants

`lib/device` owns observed current device state and device-specific actuation transport. The planner imports this module only through the producer seams allowlisted by `no-plan-to-device` (`deviceObservation.ts`, `deviceActionProjection.ts`, `deviceResidualKw.ts`); planning inputs cross that boundary as producer-resolved flat values.

## Map

- `deviceTransport.ts` — the hub class: syncs Homey state back, detects external changes, owns the actuation transport (splitting the two halves is still open work).
- `transport/` — snapshot fetch/parse, realtime capability handlers, freshness, and retained-observation accounting (`managerObservation.ts`).
- `deviceObservation.ts` — read-only view over the snapshot store; plan/executor read consumers depend on this interface, not the concrete class. House-style docblock reference.
- `deviceActionProjection.ts` — the producer that resolves observed/planner-facing bits onto `PlanInputDevice`; consumers must not re-branch on source/provenance/evidence.
- `devicePowerEstimate.ts` / `devicePowerCalibration*.ts` / `deviceResidualKw.ts` — expected-power estimation and step calibration.
- `manager*.ts` — transport halves (control, energy, flow support, measured power, native EV, native stepped command).
- `observationProducers.ts` — builds the three read-only observation producers (battery, solar, EV car-link) as one seam; none of them feeds an actuation path.
- `flowBackedDeviceState.ts` — the flow-backed device's own persisted state: flow-reported capability records, expected-power overrides (`expectedPowerOverrideState.ts`), learned peaks (`learnedPowerPeakState.ts`), and the Flow-card availability latch. It reads persistence through `devicePersistencePort.ts` and the SDK through nothing at all: `setup/flowBackedCardAccess.ts` resolves the two Flow-card lookups and builds the component. The `expectedPowerKwOverrides` and learned-peak records are shared **by reference** with `DeviceTransport`, so both helpers replace their contents in place; producing a new record would leave the transport reading an orphan.
- `targetPowerProbeScheduler.ts` — the independent retry and settlement clocks for target-power probes.
- `evCarLink*.ts` — the EV car-to-charger link **probe**: correlates class `car` devices against charger plug edges and logs what it finds. Its resolution is used only for a charger whose eligible cars the user ticked (`transport/carAssociation.ts` gates on that): the associated car's `measure_battery` becomes that charger's `stateOfCharge` (`source: 'car'`), suppressing the charger's own native/flow reading, and is dropped when the session ends. No planning or actuation consumer reads the probe directly. The association is resolved at read time — never stored on a snapshot, which would be dropped by every re-parse and stale between refreshes. Official Homey capabilities only (`ev_charging_state`, `measure_battery`); read `notes/ev-car-link/README.md` before changing it.

Design-of-record: `notes/state-management/` (especially `observer-transport-split.md`).

## Device State Invariants

**The single most important rule:** PELS must keep these five concepts strictly separate:

| Concept | Meaning |
|---------|---------|
| `planned` | What the current plan wants |
| `commanded` | What PELS most recently asked Homey/device to do |
| `observed` | What trusted telemetry most recently says the device is doing |
| `effective planning` | What the producer resolves as the planner's input right now — a conservative still-on/still-high figure the planner reads as given |
| `pending` | Requested but not yet confirmed |

**Most bugs in this area come from collapsing two of these into one.**

### Source trust order

| Question | Trust order |
|----------|-------------|
| "What did PELS ask for?" | 1. local command state → 2. pending command records |
| "What is the freshest observed value?" | 1. recent realtime event → 2. recent snapshot → 3. never observed (unknown). There is no stale rung — see `lib/observer/AGENTS.md` |
| "Did the command succeed?" | 1. confirming telemetry — timeout expiry = unknown, NOT success |

The producer resolves this ladder into the flat bits the planner consumes (`lib/observer/observedState.ts` and `transport/`, assembled onto `PlanInputDevice` in `setup/appInit/toPlanDevice.ts`): a conservative still-on/still-high figure for shed sizing, and the restore-side admission bits. The planner reads them as given — it does not walk the ladder, inspect pending records, or weigh per-device attribution itself. For hard-cap safety, whole-home power outranks per-device attribution, and `lib/power` is what answers with it.

### Hard invariants

- **No stepped control without a usable ladder.** A profile counts as stepped only when it has a step above 0 W (`hasUsableSteppedLoadLadder`). An empty ladder and an off-only ladder are the same thing — control PELS could pause but never resume — and every producer of stepped identity refuses both: `resolveTargetPowerSteppedControl` returns the config and the ladder as one value or nothing at all, `resolveNativeSteppedLoadProfileSuggestion` and `resolveNativeSteppedLoadProfile` gate on the predicate, `normalizeSteppedLoadProfile` rejects the profile outright, and `asSteppedLoadProfile` (`setup/appDeviceControlHelpers.ts`) declines it at the decorator. Consumers therefore never have to ask a `stepped_load` device where its steps went. A device left with no lane and no binary/temperature axis drops out of the snapshot on the ordinary `resolveDeviceCapabilities` gate — the same immediate, grace-free exit a binary device takes when it loses `onoff`; grace windows are for network misses, not for a device that parsed out.
- A local write (`setCapabilityValue`) is proof PELS requested a change — it is **not** proof the device converged.
- Binary `onoff` confirmation is **not** full convergence. Power draw and final behavior may still lag.
- A full snapshot refresh can be **older** than a recent realtime event or local write — never let it silently roll state backward.
- Fallback/estimated power is a planning input, not measured telemetry. Keep the distinction explicit.
- Fresh trusted observations must eventually win over local-write assumptions, older snapshots, and fallback estimates.
- "No confirmation yet" means pending/unknown — **never** treat it as success.
- Do not infer the `on` state of a device from its power consumption — power is unreliable for binary state attribution.
- An unobserved binary control resolves `currentOn` to **`false`** (non-optimistic), never a fabricated `true` — `currentOn` stays strictly `boolean` and the unknown signal lives on `binaryControlObservation`. A binary-less `device.update` must **not** synthesize an on-transition (it once did, via the optimistic default — a phantom off→on reconcile / Flow trigger). Do not re-introduce the optimism to "restore" a reconcile event.
- A non-off flow step report while the device is off **is** observed evidence, admitted on the same terms as a native one. It is real telemetry, and it is the only signal for a device that changes its own step while paused (prod 2026-07-25: an Easee charger reverts to 32 A at charging-session start and announces it while PELS's binary axis still reads off — the on-echo trailed the write by 17-37 s, so every session-start report fell inside that window; blanking it left the planner crediting a 6 A shed for a 7.36 kW draw). Suppressing it also deadlocks flow-backed restore-from-off (`prepare_for_on` can never confirm — prod 2026-07-05). The binary axis still owns the on/off fold (`resolveCurrentOn` is `!(binaryOff || steppedOff)`), so a non-off observed step never resurrects an off device, and restore sizing reads the step being restored *to*, never the observed step.
- **EV state of charge does not decay at all. The session decides whether PELS has a level, and only a plug-out ends a physical session.** Explicit `available: false` on an associated car is not a plug-out and must not fabricate an edge; it suspends the live association and car-sourced level because cached capabilities are unusable, while preserving the persisted session for connected/connected recovery. Chargers publish `measure_battery` on level CHANGE, so a connected-but-idle charger never republishes — the battery level genuinely has not moved. A clock-based age gate (`EV_SOC_STALE_MS`, 40 minutes of charge-in-motion) used to sit here and was **deleted on 2026-08-08**: it was wrong in both directions — age was measured in total wall-clock, so a charger paused longer than the window was instantly stale on resume and could not republish to clear it; and once a reading had aged out mid-charge, the next idle observation resurrected it. Do not reintroduce ageing, a "last seen" cutoff, or any staleness qualifier on this axis; the producer publishes the level it stands behind or nothing. The accepted cost is that a charger which stops reporting mid-session without Homey marking it unavailable leaves PELS holding its last published level. What remains (`transport/stateOfCharge.ts`) is the session rule: a *session anchor* is stamped only on a reconnect — a connected observation that post-dates a recorded disconnect — never on a mid-session sub-state change. `evcharger_charging_state` re-stamps its `lastUpdated` whenever it moves between connected sub-states (an Easee drops `plugged_in_charging` → `plugged_in` the second PELS pauses it), and treating that as a session start marked a two-minute-old reading stale for the rest of the night, which pinned the smart task at `objective_progress_stale` so it could never plan again (prod 2026-07-26). A full refresh sees only the current plug state, so it must reason from the retained session (`retainedSession`) rather than re-derive an anchor.

### Rules when changing reconcile or merge logic

- Drift comparison must be against **plan state**, not the last stored snapshot value.
- Realtime updates must update the observed view before drift evaluation uses that field.
- Reapply must target plan state, not the observed transition direction.
- Never let an older full fetch erase a fresher local or realtime observation without evidence it is newer.
- Preserve pending command state until confirmation or timeout.
- If an equivalent command is already pending, suppress duplicate reapply unless retry policy explicitly allows it.
- Logs must distinguish: observed transition / planned target / commanded/pending target.

Observation freshness is a producer concern — quiescent devices are not broken, and there is no staleness flag for a consumer to consult. See `lib/observer/AGENTS.md` for the quiescence rules.
