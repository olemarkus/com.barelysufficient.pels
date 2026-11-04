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
- **rangeDefaults**: the `target_power` edges for a driver that declares none.
- **zeroSetpointW**: what PELS writes for a 0 W setpoint, `0` unless the app
  reads an exact 0 as one of its own modes. A hand-back always writes an exact 0.

An `app_actions` binding is for a battery whose Homey app offers control only
through its own Flow action cards. PELS runs those cards with the owner's
Homey API key (see "App-action bindings" below). It states:

- **appUri**: the battery's app (`homey:app:<id>`); its app-level cards are
  `<appUri>:<actionId>`.
- **commandLifetime**: `persistent` (a command holds until the next) or
  `expires` after `lifetimeMs` (the app's own countdown hands the battery back).
- **resolve(device, devices)**: the battery's actions, from the host's last
  full device inventory, or why there are none (`reasonCode`, logged only).
  The actions are the signed range in PELS's sign, `command(setpointW)` (the
  ordered cards for a charge, a discharge or a 0 W hold) and `handBack` (the
  ordered cards that return the battery to its own mode). Each step names a
  card id within the app, the device it runs on and its own arguments.

The transport resolves the control surface from the binding at parse
(`lib/device/transport/homeBatteryObservation.ts`) and the storage writes at
write time (`requestStoragePower`, `releaseStorageControl` in
`lib/device/transport/deviceWrites.ts`). Planner, executor and UI read only the
resolved `HomeBatteryControlSurface`, in PELS's sign.

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
  read `PELS can only watch it: add a Homey API key to let PELS control it`
  (`needs_homey_api_key`). A saved key not yet checked, or one whose last check
  could not reach Homey, still counts: the runner checks it before its next
  action.
- **Fail closed.** The battery is drivable only while every card its commands
  and its hand-back could run (a full charge, a full discharge, a 0 W hold, the
  hand-back) is in the last inventory read, and the adapter resolved its
  actions. A missing or renamed card, an inventory not read yet, or actions
  the adapter cannot resolve make it one PELS only observes, logged once per
  reason (`home_battery_actions_unavailable`). The inventory is read when a
  full device read shows such a battery, again after an hour, and a minute
  after a failed read or a failed run.
- **No claim to observe.** The app reports nothing PELS could read as a claim.
  The battery control owner treats PELS's own claim record
  (`{ handBack: 'app_actions', claimedAtMs }`) as the claim: written before the
  first command, removed after the hand-back, recovered at boot, retried with
  back-off, like any other. Its standing is always held. **A takeover cannot
  be detected**: an owner who changes the battery's mode in its own app while
  PELS holds it is not seen, and PELS's next command overrides the change. To
  take the battery back, turn its Managed or Power-limit control off in PELS.
- **Verification** is unchanged: every command is judged against the
  battery's own `measure_power`, and the sign check against the whole-home
  meter marks a battery that moves the wrong way sign-inverted, which hands it
  back.
- **Keep-alive.** A command that `expires` is sent again at half its lifetime
  while the plan keeps deciding it (`BatteryLeverRead.keepAlive`, the storage
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
| Zendure SolarFlow 2400 AC / 800 Pro (local Zendure app, `com.tweakers.zendure` 1.0.16, driver `zendure`) | app actions: `set-power` (`power` W, ±2400, positive discharges) to command and hold 0 W; hand back `set-power` 0 (the app's idle; it has no own mode); persistent | `lib/device/zendure/` |
| Huawei LUNA2000 (`com.huawei.fusionsolar` 1.3.9, driver `luna2000_modbus`) | app actions, unsigned W on a 100 W grid: charge and 0 W hold `luna2000_start_force_charge_duration`, discharge `luna2000_start_force_discharge_duration`, each for 10 minutes; hand back `luna2000_stop_force_charge_discharge`; expires after 10 min; range from the battery's max charge and discharge power settings | `lib/device/huawei/` |
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
countdown (`cd_time`). The package documents the power's sign nowhere (the
bundled Open API PDFs say only "Setting power, [W]"); the same app titles its
Manual-mode power "Watt (negative = charge)", so the binding sends PELS's
charge as a negative power. The executor's sign check is the safety net should
a firmware read it the other way. PELS sends a 300 s countdown and sends the
command again every 150 s. The hand-back is the app's Auto mode, the battery's
own self-consumption. The cloud driver offers no cards and stays watch-only.

**Sigenergy.** The battery device reads the plant's ESS power; control is the
plant device's cards. The adapter resolves the one `plant` device of the app
from the device inventory, and the battery is unavailable with none, with two
(two systems), or with a second `battery` device (both read the same plant, so
PELS would drive it twice). The range is the plant's rated charge and discharge
power from its settings; while either is unknown the plant also refuses to
remove a limit, so PELS does not drive it. The hand-back turns remote EMS off
first, so the plant runs its own EMS even if removing a limit then fails, and
then writes both limits back to the rated power. Some firmware returns to Max
self consumption rather than the mode chosen in mySigen, and a limit the owner
had set before PELS is not restored; neither is readable through the app.

**Zendure (local app).** The app's one control is `set-power`, run on the
battery: positive discharges (`acMode` 2, output limit), negative charges
(`acMode` 1, input limit), and 0 sets both limits to 0 and `smartMode` 0, the
battery's idle. The app has no card that returns the battery to a mode of its
own, so the hand-back is that idle: the battery stays at 0 W until the owner's
own flows set it again. A 0 W hold is the same card; that is safe for an
app-action binding, which reads no claim back, so the hold cannot look like a
takeover (the Zinvolt problem). The app's 15 s poll writes `smartMode` alone
(0 when the battery reads idle, 1 when it moves) and never a limit or
`acMode`, so it does not undo a held setpoint, and the app sets no countdown:
a command lasts until the next. A write that fails twice is logged and the
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
and declares that lifetime, so the storage lane renews the run every 5
minutes, and a PELS that stops leaves the battery in its own working mode
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
