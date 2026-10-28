# Enua compatibility

`lib/device/enua/` owns compatibility with the official `no.enua:enua-charger`
driver. PELS continues to use its standard Homey charging switch, charging
state, measured power and target power. No cloud credentials or additional
Flow bridge are involved.

The shipped Homey packages inspected on 2026-10-28 were live 3.2.0 and test
3.2.1. Both declare `target_power` as 0–22080 W in 230 W steps on every grid.
Their positive-target listener instead rounds to a whole amp and clamps to
6–32 A. Its watt conversion follows the device's `grid_type` setting:

| Grid setting | Watts per amp | Minimum charging power |
|---|---:|---:|
| `1phase` | 230 | 1380 W |
| `tn_3phase` | 690 | 4140 W |
| `it_3phase` | √3 × 230 | approximately 2390 W |

The adapter repairs that specific declaration at the read boundary. The
ordinary target-power ladder then contains off and the 6–32 A watt levels,
including IT three-phase without treating it as the TN three-phase preset.
Missing or unknown grid settings follow Enua's own TN fallback. A corrected
upstream declaration, including an installation-specific lower ceiling, is
left unchanged. Neither capability values nor source timestamps are invented.

Saved PELS ranges are resolved against the same physical limits. A continuous
range uses the charger's grid watts and whole-amp steps, with at least 6 A.
An EV preset still describes the car's phase use: its planning watts are
230 W/A or 690 W/A, while Enua's command and readback watts use the grid
conversion above. The adapter converts through amps on full reads, realtime
reports and commands. Saved settings are not rewritten. Effective device
configuration stays authoritative when planning and learning reachability;
saved reachability supplies evidence only for the matching effective profile.

A configured ceiling below the physical minimum retains the real minimum
rung and resolves to a standing off requirement. The planner stops a running
device and holds a stopped one inactive, including during a smart task. The
actuator's ordinary start preflight enforces that same restriction. This is
an operating-power policy, separate from availability and command authority.

A positive target updates the wallmount current limit but does not start a
stopped session. The adapter therefore selects the existing
`current_before_start` executor order: write the planned limit, wait for its
observation, then enable charging. An acknowledged request alone must not
permit starting at a previous, higher limit.

The executor's shared preparation rule rejects an older command confirmation
when the charger reports a different positive limit. A swallowed vendor error
can otherwise leave a successful Homey command record beside a limit that
never changed. Off-step or absent reports retain the existing Flow preparation
behavior; a matching positive observation still confirms normally.
An out-of-range positive report keeps its exact watt id rather than being
labelled as the nearest allowed rung. In particular, a retained 32 A limit
cannot confirm a 6 A preparation when the owner permits only that one rung.

Stopping uses the standard charging switch. Enua keeps the wallmount current
limit while stopped, so its next cloud poll can report a positive target again
alongside charging disabled and zero measured power. That limit is not proof
that charging resumed, and it is not a reason to enable the charger.

`test/e2e/enuaChargerSdkE2E.test.ts` drives the real PELS stack through the Homey
boundary with the shipped range, the 6 A clamp, delayed cloud observations and
retained stopped-session limits. The pure compatibility tests also check that
corrected metadata and unrelated drivers remain unchanged. Reassess the shim
when Enua changes its capability range or its target/start behavior.
