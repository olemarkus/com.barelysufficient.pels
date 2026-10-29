# Enua compatibility

`lib/device/enua/` owns compatibility with the official `no.enua:enua-charger`
driver. PELS uses its standard Homey charging switch, charging state, measured
power and target power. No cloud credentials or additional Flow bridge are
involved. Everything Enua-specific stays in the adapter; shared code reaches it
only through the `DeviceAdapter` hooks, which pass values through unchanged for
every other device.

The shipped Homey packages inspected on 2026-10-28 were live 3.2.0 and test
3.2.1. Both declare `target_power` as 0–22080 W in 230 W steps on every grid.
Their positive-target listener instead rounds to a whole amp and clamps to
6–32 A. Its watt conversion follows the device's `grid_type` setting:

| Grid setting | Watts per amp | Minimum charging power |
|---|---:|---:|
| `1phase` | 230 | 1380 W |
| `tn_3phase` | 690 | 4140 W |
| `it_3phase` | √3 × 230 | approximately 2390 W |

`overlay` repairs that specific declaration at the read boundary, so the
ordinary target-power ladder contains off and the 6–32 A watt levels. IT
three-phase is not treated as the TN three-phase preset. A missing or unknown
grid setting follows Enua's own TN fallback. A corrected upstream declaration,
including an installation-specific lower ceiling, is left unchanged. Neither
capability values nor source timestamps are invented.

`configureTargetPower` resolves a saved PELS range against the same physical
limits. A continuous range uses the charger's grid watts and whole-amp steps,
with at least 6 A. An EV preset still describes the car's phase use: its
planning watts are 230 W/A or 690 W/A, while Enua's command and readback watts
use the grid conversion above. `stepCommand` and `targetPowerReading` convert
through amps on commands, full reads and realtime reports. Saved settings are
not rewritten.

A positive target updates the wallmount current limit but does not start a
stopped session. The adapter therefore selects the existing
`current_before_start` activation order: write the planned limit, wait for its
observation, then enable charging.

Stopping uses the standard charging switch. Enua keeps the wallmount current
limit while stopped, so its next cloud poll can report a positive target again
alongside charging disabled and zero measured power. That limit is not proof
that charging resumed, and it is not a reason to enable the charger.

`test/e2e/enuaChargerSdkE2E.test.ts` drives the real PELS stack through the
Homey boundary with the shipped range, the 6 A clamp, delayed cloud
observations and retained stopped-session limits. `test/unit/enuaCompatibility.test.ts`
also checks that corrected metadata and unrelated drivers remain unchanged.
Reassess the adapter when Enua changes its capability range or its
target/start behavior.
