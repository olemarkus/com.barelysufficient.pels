# OCPP Server compatibility

`lib/device/ocppServer/` owns the community OCPP Server app's charger
(`com.dnetlabs.ocpp`, `charger` driver, Homey class `evcharger`), which lets
an OCPP 1.6 charger connect to Homey. Behaviour as of version 1.0.16.

**Surface.** The device publishes `evcharger_charging` (setable),
`evcharger_charging_state` (Homey's values), `target_power` (setable, W),
`target_power_mode`, `measure_power`, `measure_current` (and
`measure_current.l1`/`.l2`/`.l3` when the charger reports them),
`measure_voltage` and `meter_power`. Its device settings include `phases`
(the string `"1"` or `"3"`), `max_current` (A) and `stop_behavior`; a freshly
paired charger reads `stop_behavior` `stop`.

| Command | What the app does |
|---|---|
| `evcharger_charging` true | Starts a session (a new transaction) |
| `evcharger_charging` false | Stops the session (ends the transaction) |
| `target_power` above 0 W | Sets the charger's current limit; never starts a session. `target_power_mode` becomes `homey` |
| `target_power` 0 W or less | Pauses an open session at 0 A when `stop_behavior` is the pause option; otherwise ignored |

**Empty switch.** Right after pairing, with a car plugged in and no session
yet, the app reports `evcharger_charging` empty (null) next to `plugged_in`;
it sets the switch true when a session starts and false when it stops. The
adapter reads an empty switch as off (`projectRead` on full reads and device
updates, `normalize` on a single report), dated by its own reading or else by
`evcharger_charging_state`, so PELS starts a plugged-in car when there is
room. An empty switch with neither date stays unread.

**Watt ladder.** `target_power` runs from 0 W to `max_current` × `phases` ×
230 V in steps of `phases` × 230 V (1 A), with no charging minimum, so the
native ladder would start at 1 A. `overlay` adds the 6 A floor on the
device's phases as the exclusion band (`excludeMin` 0, `excludeMax` 6 A), and
keeps the step at one amp on those phases and the maximum on a whole amp:

| `phases` | Watts per amp | First charging step |
|---|---:|---:|
| `"1"` | 230 | 1380 W |
| `"3"` | 690 | 4140 W |

The floor needs the phases. With `phases` missing or anything but `1` or `3`,
the device is parsed without `target_power` and `target_power_mode`
(`withheldCapabilities`): PELS offers no native ladder, makes no claim on the
mode, and plans the charger through its switch alone. A saved continuous range
in Manual resolves to the same whole amps from 6 A (`configureTargetPower`); an
EV preset passes through, and its amp steps are sent in the charger's own
watts per amp (`stepCommand`, `targetPowerReading`).

**Start and stop.** A positive target only changes the limit, so the adapter
selects the `current_before_start` activation order, as for Enua: PELS writes
the planned limit, waits to read it back, then sets `evcharger_charging` true,
which opens a session at that limit. When the limit has to change first, the
start follows it after the ordinary five-minute restore pacing, as for Enua;
a limit already in place is started at once. The app never republishes
`target_power` itself, so the limit is read from Homey's echo of PELS's write
and from later full reads. The off step is `evcharger_charging`
false. PELS's native watt path turns a charger off through its standard switch
whenever the switch only starts and stops (Enua, Zaptec); Alfen turns off with
a 0 W target only because its app's switch sets the station maximum. Here a
0 W target stops nothing under the default `stop_behavior` `stop`, and PELS
writes none, so start and stop work the same with every `stop_behavior`. A
stopped session is a new transaction on the next start.

`test/unit/ocppServerCompatibility.test.ts` checks the ladder on one and three
phases and the missing ladder without a valid `phases`.
`test/e2e/ocppServerChargerSdkE2E.test.ts` drives PELS against a model of the
app on both phase counts: the ladder from 6 A, kept across full refreshes and
device updates; a step-down under pressure that never goes below 6 A; a stop
when 6 A does not fit followed by a new session at a safe limit when room
returns; a freshly paired charger with an empty switch started when there is
room; a new session after a stop made elsewhere; and, once the app adds the
per-phase `measure_current.lN`/`measure_voltage.lN` readings after the first
session, the same floor and the same restart.
