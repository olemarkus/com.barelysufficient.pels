# Observer

`lib/observer/` owns trusted device observation, idle classification, and pending binary command evidence. It supplies current state to planning and execution; it does not decide desired state or issue commands. See `notes/idle-classification.md` and `notes/state-management/observer-transport-split.md` for the detailed model.

## A device observation never times out

Homey often reports a capability only when its value changes. A quiet device therefore keeps its last accepted observation until the observer replaces or invalidates it. Do not add an age cutoff, stale state, or periodic refetch merely because it has been quiet. Distinguish **never observed** from an explicit `available === false`; only the latter marks a previously known device unavailable.

EV state of charge has a separate physical-session validity rule in `lib/device/AGENTS.md`; it has no silence-based expiry. Whole-home meter silence is owned by `lib/power/`. `generationFreshness.ts` separately governs a held generation reading.

## External-off hold

`externalOffHold.ts` stores the persisted hold posture, but it does not decide whether a hold applies. Provenance detection and the cross-domain projection stay with their owning integration seams (`setup/externalOffHoldDetection.ts` and `lib/planInput/externalOffHoldProjection.ts`). The observer's state remains an input, not a planner decision.
