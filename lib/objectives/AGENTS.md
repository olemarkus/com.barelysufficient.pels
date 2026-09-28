# Objectives

`lib/objectives/` learns each device's energy rate and owns deferred objectives (smart tasks). It supplies flat, resolved decorations to the planner through an injected seam; planner code does not import this module. See `notes/deferred-load-objectives/README.md` and the nested `deferredObjectives/AGENTS.md` when changing smart-task behavior.

## Learned profiles

- Judge a candidate window against that device's own rate history in `energyBand.ts`; a fleet-wide plausible rate cannot span heaters and EVs. The age-bounded sample buffer is the sole record, and derived band/stat values must follow it as old samples leave.
- When a rejection invalidates a window, void that window at the point the reason is decided. Keeping its cumulative baseline would carry bad energy and value into the next candidate. Do not add a generic suppression period after one bad window.
- Read producer-resolved `ObjectiveDeviceInput` facts, not raw device provenance. Confirm any new field survives the producer projection and make guaranteed fields required. Keep commandability distinct from a creditable EV session.

Objectives consume observation and narrow injected stores; they do not select sheds, issue actuation, or import peer plan/device/price/executor modules. The import boundary is enforced by `.dependency-cruiser.cjs` and `npm run arch:grep`.

The objective boundary selects metered planner devices and injects observer-resolved thermal direction. Read these resolved `ObjectiveDeviceInput` facts instead of raw device provenance. Confirm a new field survives that producer projection, and require fields the producer guarantees. Keep `objectiveSessionInactive` distinct from `commandableNow`: a temporarily unavailable charger may still have a creditable EV session.
