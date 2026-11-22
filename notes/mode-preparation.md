# Mode preparation

A mode schedule can have its heating devices ready when the new mode starts. For
example, schedule Home for 08:00 and turn on **Have devices ready by then**.
Each eligible device gets its own start time. The mode still changes at 08:00.

## Eligibility and timing

The earliest eligible mode schedule governs. Preparation cannot run across an
intervening eligible mode schedule. The schedule must be on, its mode must
exist, and its condition must match the current mode. Pausing mode schedules
also pauses preparation.

Preparation applies to managed heating devices in Main with standing command
authority, an observed temperature, and saved targets in both modes, with a higher destination target.
Targets are normalized to the device's capability before comparison. Devices
set to **Keep the new temperature** and devices in separately metered areas
follow their ordinary policies. A temperature override or an open Smart task
takes precedence while it is active.

Start time is the mode change time minus the device's estimated lead. Use the
learned heating energy from the current mode target to the next target divided
by the Smart task planning speed, plus 30 minutes, capped at six hours. When a
learned estimate or planning speed is unavailable, use two hours. The calculation
uses the current mode target so an observed temperature rising during preparation
doesn't move its start time. A device starting below the current target can
need more time. After the first plan uses the early target, PELS remembers the
start for the occurrence so refinements to the learned profile cannot stop it
again. After a restart, PELS recalculates the lead from its current profile.

Once a device starts, the planner uses its destination mode target as its base.
Per-device price and solar adjustments, priority, daily budget and power limits
apply as usual. Preparation grants no extra control authority, reservations or
budget exemptions. The current mode still sets device priorities until the
switch. A prepared room can arrive late.

## Plan on Smart tasks

The **Getting ready for Home** panel shows the next eligible mode change and when
each heater is estimated to start heating. An open Smart task or temperature
override shows what comes first now. The panel links to the Smart task, the
device and the mode schedule; a mode schedule row with preparation on links back
with **View plan**.

The estimates use current mode targets and the same heating lead as preparation.
An intervening mode change can alter which targets apply. Available power and the
daily budget still determine when a device can heat.

## Handoff and reporting

The schedule owner resolves the occurrence with the same condition, conflict and
receipt rules as the mode action. The preparation survives a late tick within
the existing catch-up window. The schedule writes its consumption receipt and
changes mode through the usual action. Preparation takes effect on the next
meter-driven plan. It adds no timer or rebuild trigger.

The thermostat owner resolves the early target. Under **Save as current mode
target**, the write fence allows that target and an external setpoint change
during preparation does not replace the current mode's saved preference.
Use a temperature override to set a different target during preparation.

The device card, thermostat or stepped water heater, can read **Getting ready for Home at 08:00**. At the schedule
trigger, PELS counts participating devices that report at least their target
minus 0.5 °C. The last result can read **Mode changed. 5 of 6 devices were
ready.** The stored result describes what PELS observed when running the
schedule. Preparation uses the existing schedule settings and route.

## Starting from a Flow

**Prepare operating mode** creates a one-off mode schedule named **Mode
preparation from Flow**. Each successful run replaces the previous request in
that schedule. Ordinary mode schedules still apply. A ready-by time uses
Homey's local clock and rolls to tomorrow if today's occurrence has passed or
does not exist. During a repeated hour, only the first occurrence is used. If
tomorrow's time does not exist, the Flow reports an error.
