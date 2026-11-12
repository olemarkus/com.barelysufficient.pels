# Home battery vendor bindings

A home battery's **binding** says how PELS drives it through its Homey app. It
belongs to the battery's integration adapter (`DeviceAdapter.homeBatteryBinding`,
`lib/device/deviceAdapter.ts`); common code reads it and names no app. The
standard binding (`lib/device/homeBatteryBinding.ts`) is Homey's own: a
writable signed `target_power` (positive charges) taken over through
`target_power_mode` set to `homey`. A battery whose app follows Homey's
conventions needs no adapter.

A `capability` binding states:

- **claims**: the capabilities that hand the battery to Homey, in preference
  order, each with its Homey value and what a rejected write means
  (`unanswered`, or `app_refuses_control` for an app that refuses PELS in its
  current setup). The first one the battery declares setable with that value
  is its claim.
- **setpointSign**: `1` when a positive `target_power` charges, `-1` when the
  app reads it as discharge. PELS keeps its own sign (positive charges) above
  the transport. The declared range is flipped into it at parse
  (`resolveBatteryControlSurface`) and each setpoint back out at write
  (`toBatterySetpointCapabilityValue`). `measure_power` is Homey's sign
  (positive charging) in every app below, so it is never flipped and the
  executor's sign check compares like with like.
- **rangeDefaults**: the `target_power` edges for a driver that declares none. Homey fills an undeclared edge with its own default (±25 kW, step 1), so PELS reads that value as undeclared.
- **zeroSetpointW**: what PELS writes for a 0 W setpoint, `0` unless the app
  reads an exact 0 as one of its own modes. A hand-back always writes an exact 0.

An `app_actions` binding is for a battery whose Homey app offers control only
through its own Flow action cards. PELS runs those cards with the owner's
Homey API key (see "App-action bindings" below). It states:

- **appUri**: the battery's app (`homey:app:<id>`); its app-level cards are
  `<appUri>:<actionId>`.
- **commandLifetime(setpointW)**: per command, in PELS's sign: `persistent`
  (it holds until the next) or `expires` after `lifetimeMs` (the app's own
  countdown, or its own policy, drops it). An app may keep some commands and
  drop others.
- **resolve(device, devices)**: the battery's actions, from the host's last
  full device inventory, or why there are none (`reasonCode`, logged only).
  The actions carry the exact target, the signed range in PELS's sign, and
  `command(setpointW)` (the ordered cards for a charge, discharge or 0 W hold).
- **resolveTarget(device, devices)**: the app and controlled device identity,
  independent of command range and admission.
- **handBack(target, devices)**: cards that return that recorded target to its own mode,
  from the same inventory as `resolve`, for an app whose card depends on the
  target device's driver.
- **resolveLegacyTarget(device, devices)**: the adapter's upgrade policy for
  claims written before target identities were persisted.

The battery owner stores the target in `battery_control_claim.<deviceId>`
before the first write and carries it through the actuator on commands and
hand-back. Transport checks command identity again before each action POST.
Retries and restart recovery always use that stored target. Records contain
identity, never executable card IDs or arguments. Legacy self-target claims
can be released by their adapter. Legacy Sigenergy claims lack the old plant
identity, so their upgrade recovery uses the sole current plant, including
a replacement, when the inventory has only one Sigenergy battery. Missing or
multiple plants and multiple batteries keep recovery pending. This is the
compatibility policy for old records only; a record with a target always
returns that exact plant to its own EMS. Legacy hand-back is resolved without
requiring rated powers, so remote EMS can be turned off before a failed
limit-cleanup action is retried. The legacy record stays until all hand-back
actions succeed.

The transport resolves the control surface from the binding at parse
(`lib/device/transport/homeBatteryObservation.ts`) and the storage writes at
write time (`requestStoragePower`, `releaseStorageControl` in
`lib/device/transport/deviceWrites.ts`). Planner, executor and UI read only the
resolved `HomeBatteryControlSurface`, in PELS's sign.

## Meter-mode bindings

A `meter_modes` binding is for a battery with no power setpoint that follows the
whole-home meter in a mode written to its claim capability. It states the claim
capability, what a rejected write means, the capability's value for each kind
of command (`discharge`, `hold`, `chargeSurplus`, `chargeGrid`) and
`resolvePowers`, the most the battery discharges and charges from its own reads.
The surface resolver (`resolveMeterModeSurface`, `lib/device/batteryControlWiring.ts`)
turns it into a `setpoint` surface whose `response` is `follows_meter`, with the
charge power as its one grid-charge power; every other battery's `response` is
`delivers_setpoint`, carrying the claim value that hands it to Homey.

- **Command.** A setpoint maps to one mode (`meterModeFor`,
  `lib/ports/homeBatteryResponse.ts`): any discharge covers the house's import, 0 W
  holds, a charge below the grid-charge power takes surplus only, and a charge at
  it charges at that power, from the grid when surplus falls short. The transport
  writes that mode to the claim capability; there is no `target_power` write.
- **Claim and hand-back.** The claim record is the ordinary `claim_capability`
  one: the mode the battery held before PELS's first write, restored on
  hand-back with no zero-setpoint write first. Any of PELS's four modes reads
  as engaged; a mode outside them, reported after PELS's last write, is
  contested and then a takeover. A mode the owner left the battery in, even
  one of PELS's, is recorded and restored, never refused as someone else's
  claim.
- **Own mode's grid charge.** A limit hold is handed back once the room fits
  what the battery's own mode takes from the grid (`resolveOwnModeChargeW`).
  For a meter-following battery that is declared by the mode it returns to,
  the recorded one (`toOwnModeGridCharge`): 0 for a mode that only follows the
  meter, the grid-charge power for one of `gridChargingModes`. Its charge
  ceiling says nothing about it: a mode that holds the meter at zero takes
  only surplus.
- **Confirmation.** The storage lane judges the battery by the mode it reports,
  never its power (`settleMeterMode`, `lib/executor/batteryExecutor.ts`): in its
  mode it covers whatever the house imports or exports, so its power teaches no
  ceiling, and one with nothing to cover is idle, not unresponsive. A command
  still unreported past the confirmation window goes out again at the next
  rebuild, unless the battery left PELS's modes, which is a takeover.

## HomeWizard Plug-In Battery

`lib/device/homewizard/` (HomeWizard app `com.homewizard` 3.20.3) is the one
`meter_modes` binding. The batteries take no power setting; the P1 meter
(`energy_v2`) holds the whole group's one mode, `battery_group_charge_mode`
(`zero`, `zero_charge_only`, `zero_discharge_only`, `standby`, `to_full`,
`predictive`), and the group's power (`measure_power.battery_group_power_w`,
positive charging), average charge level (`battery_group_average_soc`) and
limits (`measure_power.battery_group_max_consumption_w` to charge,
`..._max_production_w` to discharge).

- **One battery per group.** The adapter reads the P1 as two views
  (`DeviceAdapter.projectRead`): the P1 under its own id, still the whole-home
  meter (the meter pickers and the boot-time meter adoption read Homey
  Energy's report and the raw registry, which never hold a view), and the group
  as a battery, `<P1 id>~battery_group`. Each `plugin_battery` device is read
  by no view: its power and level are the group's again, and its own
  `target_power_mode` accepts only `device`.
- **Modes.** Discharge `zero_discharge_only`, hold `standby`, surplus charge
  `zero_charge_only`, grid charge `to_full` at the group's charge limit,
  which is also its one grid-charge power. The firmware's limit can be one
  battery's even with several (the app's own comment, `drivers/energy_v2/device.js`
  near the WebSocket battery handler). A group whose limits the P1 has not
  reported is watched only.
- **Writes.** PELS writes the mode capability on the P1. Its listener drops a
  change made within 5 s of the last one and still answers success
  (`drivers/energy_v2/device.js`, the `battery_group_charge_mode` listener),
  so a command is confirmed only when the P1 reports the mode; an unreported
  one goes out again. A hand-back is confirmed the same way: PELS keeps the
  claim record until the P1 reports the restored mode, and writes the
  hand-back again if the group still shows another mode 15 s later
  (`HAND_BACK_REPORT_WINDOW_MS`). The listener also counts every write by another app and
  logs it as a likely override (`capability_api_mode_changes`): each PELS
  command adds one. That is an accepted cost; the app's Flow cards avoid the
  counter but need the owner's Homey API key and leave no mode to restore.
- **No export.** In every mode the group holds the P1 at zero: it covers the
  house's import or takes its export, never sells to the grid.

## App-action bindings

The common host is `lib/device/homeBatteryAppActions.ts`; the adapter only
builds card ids and arguments. All I/O stays with the host: the card inventory
(`manager/flow/flowcardaction`), the device reads, and the runs, through the
one owner of the owner's Homey API key, `HomeyActionAccess`
(`lib/device/transport/homeyActionAccess.ts`). Charger current shares that
owner: one key (setting `_homey_flow_api_key`, entered where charger current
asks for it), one key generation, one action in flight per device, the same
timeouts, and a permission refusal that invalidates the key for both. The
battery's device page offers the same key block as a charger's page
(`HomeyApiKeySetup`, the existing `ui_charging_access*` routes) while its
control reads `needs_homey_api_key`, and keeps it there to check, replace or
remove once the key is saved (`batteryUsesHomeyApiKey` on the device list).

- **API key.** With no key saved, or one Homey refused Flow permission, the
  battery is one PELS only watches: its card, device page and device-list row
  read `PELS can only watch it: add a Homey API key so it can help with your limit and solar`
  (`needs_homey_api_key`). A saved key not yet checked, or one whose last check
  could not reach Homey, still counts: the runner checks it before its next
  action.
- **Fail closed.** The battery is drivable only while every card its commands
  and its hand-back could run (a full charge, a full discharge, a 0 W hold, the
  hand-back) is in the last inventory read, and the adapter resolved its
  actions. A missing or renamed card, an inventory not read yet, or actions
  the adapter cannot resolve make it one PELS only observes, logged once per
  reason (`home_battery_actions_unavailable`). A hand-back needs only its own
  cards: with a command card missing but the hand-back cards installed
  (`hand_back_only`), PELS claims the battery no more and still hands it back.
  The inventory is read when a full device read shows such a battery, again
  after an hour, and a minute after a failed read, a failed run, or a read
  that lacked one of a bound battery's cards.
- **Removing the key.** The settings UI's Remove key first hands back every
  battery PELS holds through its app's actions, on the key that is still
  saved, and claims none of them meanwhile
  (`BatteryControlOwner.handBackBeforeHomeyApiKeyRemoval`). If one whose
  hand-back could run is still held, the key is kept and the page says so: a
  battery whose app holds a command until the next would otherwise run PELS's
  last command on with nothing left to hand it back.
- **No claim to observe.** The app reports nothing PELS could read as a claim.
  The battery control owner treats PELS's own claim record
  (`{ handBack: 'app_actions', target, claimedAtMs }`) as the claim: written before the
  first command, removed after the hand-back, recovered at boot, retried with
  back-off, like any other. Its standing is always held. **A takeover cannot
  be detected**: an owner who changes the battery's mode in its own app while
  PELS holds it is not seen, and PELS's next command overrides the change. To
  take the battery back, turn its Managed or Power-limit control off in PELS.
- **Verification** is unchanged: every command is judged against the
  battery's own `measure_power`, and the sign check against the whole-home
  meter marks a battery that moves the wrong way sign-inverted, which hands it
  back.
- **Keep-alive.** A setpoint whose command `expires` is sent again at a third of its
  lifetime while the plan keeps deciding it, and a re-send that fails is tried
  again 20 s later (`KEEP_ALIVE_RETRY_MS`), so one failure still leaves
  several tries before the app's countdown runs out (`BatteryLeverRead.keepAliveFor`, the storage
  lane's drift in `lib/executor/batteryExecutor.ts`). It goes through the
  owner's admission and Main's fenced actuator like any setpoint, so nothing
  below the actuator seam keeps a battery PELS should release. When the meter
  goes silent the plan stops, nothing is re-sent, and the app's countdown
  returns the battery to its own mode.

## Batteries and their bindings

Read from the shipped app packages.

| Battery and Homey app | Binding | Adapter |
|---|---|---|
| Marstek Venus (`com.kaoh.marstek`), AlphaESS (`com.alphaess`), SOLARWATT (`com.solarwatt`), SolarEdge (`com.solaredge`, `battery_modbus`) | standard | none |
| Sessy (`nl.sessy`) | claim `control_strategy` = `POWER_STRATEGY_API`, rejection = `app_refuses_control`; range defaults -1800/+2200 W | `lib/device/sessy/` |
| Anker SOLIX (`com.anker.solix` 1.1.0, driver `battery`) | standard claim; `setpointSign` -1 | `lib/device/anker/` |
| Zinvolt (`com.zinvolt` 1.1.0, drivers `base`, `power`) | standard claim; `zeroSetpointW` 10 | `lib/device/zinvolt/` |
| Marstek Venus (Marstek Battery Connector, `com.niewold.marstek` 0.9.1, driver `marstek-venus`) | app actions: `marstek_passive_mode` (`power` W, negative charges; `seconds` 300) to command, `marstek_auto_mode` to hand back; expires after 300 s; ±2500 W | `lib/device/marstek/` |
| Sigenergy (`com.sigenergy` 0.6.6, driver `battery`, cards on the `plant`) | app actions on the plant, kW: charge `force_charge_from_grid`; discharge `set_ess_max_discharge_power` then mode 6; hold mode 1 (Standby); hand back `set_remote_ems` off, then both limits removed; persistent; range from the plant's rated powers | `lib/device/sigenergy/` |
| Zendure SolarFlow 2400 AC / 800 Pro (local Zendure app, `com.tweakers.zendure` 1.0.16, driver `zendure`) | app actions: `set-power` (`power` W, ±2400, positive discharges) to command and hold 0 W; hand back `set-power` 0 (the app's idle; it has no own mode); a charge expires (90 s), a discharge and the hold persist | `lib/device/zendure/` |
| Huawei LUNA2000 (`com.huawei.fusionsolar` 1.3.9, driver `luna2000_modbus`) | app actions, unsigned W on a 100 W grid: charge and 0 W hold `luna2000_start_force_charge_duration`, discharge `luna2000_start_force_discharge_duration`, each for 10 minutes; hand back `luna2000_stop_force_charge_discharge`; expires after 10 min; range from the battery's max charge and discharge power settings | `lib/device/huawei/` |
| SolaX battery (`com.msd.inverter.solax` 4.4.10, driver `solax_modbus_battery`, cards on the inverter) | app actions on the inverter: `set_remote_control_power_ram_<suffix>` mode 4 (Push Power, `power` W, positive charges) with a 300 s `timeout` to command and hold 0 W; hand back `disable_remote_control_ram_<suffix>`; expires after 300 s; ±30 kW | `lib/device/solax/` |
| Zendure cloud app (`com.zendure.flow` 1.0.25: SolarFlow 800, 800 Plus, 800 Pro, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro, 4000 Mix AC+, 4000 Mix Pro, Hyper 2000); Huawei `luna2000_emma_modbus` and the FusionSolar OpenAPI drivers | standard (no `target_power`): watch-only | none |

## What each adapter does and why

**Sessy.** Sessy declares no `target_power_mode`. Its `target_power` acts only
under the `POWER_STRATEGY_API` control strategy, and the app refuses to set a
strategy unless the battery uses its local login, so a rejected claim means its
app refuses control (the battery is watch-only for a while). Its driver
declares no range, so the edges are the app's own charge and discharge presets
rather than Homey's ±25 kW.

**Anker SOLIX.** The app's own `target_power` is titled "On-Grid Port Output
Power (+) / Grid-to-Battery Charge Power (-)" and goes unchanged into the
battery's setpoint register: positive discharges. Without the flip PELS would
discharge when it meant to charge, and the executor's sign check would
eventually mark the battery sign-inverted and stop driving it.

**Zinvolt.** The app maps an exact 0 W `target_power` onto its own `INACTIVE`
mode, and polls then report `target_power_mode` = `INACTIVE`, which PELS
reads as the owner taking the battery back. The binding writes the app's
smallest charge step, 10 W, for a 0 W hold, so `INACTIVE` keeps one meaning:
someone other than PELS chose it. Counting `INACTIVE` as engaged instead would
hide an owner who picks Inactive while PELS holds the battery, and would make
PELS refuse a battery left Inactive. The cost is a 10 W trickle charge during a
0 W hold.

**Marstek Venus (Connector app).** The local driver declares no
`target_power`, only readings; its passive-mode card sets a power for a
countdown (`cd_time`). The power is negative to charge and positive to
discharge, the device's convention, so the binding sends PELS's charge as a
negative power. PELS sends a 300 s countdown and sends the
command again every 100 s. The hand-back is the app's Auto mode, the battery's
own self-consumption. The cloud driver offers no cards and stays watch-only.

**Sigenergy.** The battery device reads the plant's ESS power; control is the
plant device's cards. The adapter resolves the one `plant` device of the app
from the device inventory, and the battery is unavailable with none, with two
(two systems), or with a second `battery` device (both read the same plant, so
PELS would drive it twice). The range is the plant's rated charge and discharge
power from its settings; while either is unknown the plant also refuses to
remove a limit, so PELS does not drive it. The hand-back turns remote EMS off
first, then removes both charge and discharge limits through the app's cards.
These limits apply independently of EMS mode. The app uses its persisted rated
powers to clear them; if those are unknown or a cleanup card fails, remote EMS
is already off and the claim remains pending for cleanup retries. The durable claim retains the plant
target until hand-back succeeds; pairing another plant, including across a
restart, does not redirect that hand-back or authorize commands on the replacement. Some firmware returns to Max
self consumption rather than the mode chosen in mySigen, and a limit the owner
had set before PELS is not restored; neither is readable through the app.

**Zendure (local app).** The app's one control is `set-power`, run on the
battery: positive discharges (`acMode` 2, output limit), negative charges
(`acMode` 1, input limit), and 0 sets both limits to 0 and `smartMode` 0, the
battery's idle. The app has no card that returns the battery to a mode of its
own, so the hand-back is that idle: the battery stays at 0 W until the owner's
own flows set it again. A 0 W hold is the same card; that is safe for an
app-action binding, which reads no claim back, so the hold cannot look like a
takeover (the Zinvolt problem). The app's 15 s poll writes `smartMode` alone:
0 when the battery reads idle (`outputLimit` 0 and both powers 0), 1 when it
moves. A charge always has `outputLimit` 0, so a charge on a full battery, or
one still ramping, gets `smartMode` 0 within one or two polls, and the
battery drops the charge set in RAM for the values in its flash. So a charge
expires: PELS declares 90 s and the storage lane sends it again every 30 s, a
`smartMode` 1 write to RAM only. A discharge (`outputLimit` > 0) never reads
idle and holds until the next command. The 0 W hold is the app's idle itself,
a flash write, and holds until the next command; PELS never repeats it on a
timer. A write that fails twice is logged and the
card still succeeds, so only the executor's verification against
`measure_power` (grid input while charging, minus home output otherwise,
Homey's sign) sees it.

**Zendure (cloud app).** Every battery driver offers AC input (charge) and AC
output (discharge) power cards, but declares only `measure_battery` and
`battery_charging_state`: no `measure_power`. PELS would command a battery it
cannot verify, and the app's card handlers swallow a failure and return
`false`. The battery stays watch-only on the standard binding.

**Huawei LUNA2000 (Modbus).** The timed forced-run cards write the power, the
minutes, the duration mode and the start in that order, starting nothing if a
step fails, and the battery's own timer ends the run. PELS sends 10 minutes
and declares that lifetime, so the storage lane renews the run every 200 s
(a third of it), and a PELS that stops leaves the battery in its own working mode
within 10 minutes. The cards take unsigned W and clamp to the battery's max
charge or discharge power (registers 47075 and 47077, kept in the device
settings by the app's poll); the range is those settings on the cards' 100 W
grid, and while either is unknown or 0 (which also fails the card) PELS only
watches the battery. A 0 W hold is a forced charge at 0 W, which the card
accepts; the stop card is the hand-back, returning the battery to its working
mode. `measure_power` is Homey's sign, read on the driver's poll (60 s by
default), so verification is slower than for a local battery. The EMMA driver
offers only working-mode and grid-charge cards, and the OpenAPI drivers are
read-only: both stay watch-only.

**SolaX (Modbus).** The battery device only reads the inverter it follows;
the cards are on the inverter, one pair per inverter driver (`g4`, `g4_pro`,
`x1_vast`, `x3_ies`, `ultra`), and G3 inverters have none. The battery's
chosen inverter sits in the app's device store, which Homey does not list, so
the adapter needs the only SolaX Modbus inverter and the only SolaX battery in
the inventory; with two of either, PELS only watches. The card writes the
inverter's VPP block in RAM, never its EEPROM. Mode 4 (Push Power) sets the
battery's own power; the card takes it positive to charge, and the app negates
it into the register, where positive discharges. The inverter leaves remote
control after the timeout unless the block is written again, and the app
writes it again every half timeout until the disable card runs. PELS sends a
300 s timeout and declares that lifetime, so its own re-send every 100 s keeps
the command after an app restart, which drops the app's keep-alive. Because the
app keeps re-sending, a PELS that stops leaves the battery on its last command
until the hand-back, as for a persistent command. The hand-back writes remote
control off, and the inverter returns to its own work mode. The card id of the
hand-back depends on the inverter's driver, so `handBack` takes the inventory:
an inverter missing from it names a card no app lists, the hand-back fails,
and the claim stays owed. The package reads no battery limit, so the range is
the card's ±30 kW, and a battery that delivers less teaches PELS its plateau.
Both cards unlock the inverter first only when its `auto_unlock` setting is
on; a refused write fails the card. `measure_power` is the inverter's battery
power, positive while charging (the app's load is solar minus feed-in minus
battery power): Homey's sign.

**Not bound.** Read from the shipped packages; each stays watch-only.

- *Sonnen* (`com.sonnen.battery` 2.8.0): manual charge and discharge
  setpoints work only in the Manual operating mode, and every card run posts a
  Homey timeline notification (`drivers/sonnenbatterie/driver.js`
  `handleSwitchOperatingMode`, `handleManualCharging`,
  `handleManualDischarging`), so each PELS setpoint change would post one.
- *Solis* (`nl.orangeframe.solis` 1.0.0): forced charge and discharge take
  amps, which the app converts with its own cached battery voltage, and there is
  no 0 W hold: the smallest charge is 1 A, and the stop card returns the battery
  to self-use.
- *Indevolt* (`nl.robceelen.indevolt` 1.8.2): real-time control takes a state
  and W, but the drivers report the battery's power only as separate
  `measure_power.charge` and `measure_power.discharge`, with no `measure_power`
  PELS could verify a command against.
