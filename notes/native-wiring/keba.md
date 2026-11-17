# KEBA compatibility

`lib/device/keba/` owns the KEBA app (`se.cohen.keba`, local UDP, driver
`keba-p30` for the P20 and P30). Behaviour as of version 1.1.17.

**Start and stop.** The app declares neither `evcharger_charging` nor
`evcharger_charging_state`. On the `keba-p30` driver `onoff` is setable: false
disables charging and true enables it. The app's 10 s poll publishes the
charger's own enabled state on `onoff`, so the reading is the charger's
answer, not an echo. The adapter reads and writes the switch on `onoff` and
publishes it as `evcharger_charging`. The charger keeps its current across a
stop, so the planned current goes out before the switch
(`current_before_start`).

**Plug state.** The poll publishes two booleans: `plug_status`, a cable
plugged into a car, and `charge_status`, a session that draws. The adapter
derives the plug state from them and the switch:

- `plug_status` false: `plugged_out`.
- `charge_status` true: `plugged_in_charging`.
- `onoff` false: `plugged_in_paused`.
- Otherwise: `plugged_in`, a car that takes nothing.

A missing or malformed reading leaves the state unread. The derived state is
dated by the newest reading it stands on.

**Charging current.** `charge_power` is the charger's current limit in amps,
declared read-only. The app's `set_charge_power` card sets it (6-63 A in the
card) and the poll publishes the charger's limit back. The adapter offers the
card as built-in current control through the owner's Homey API key, scoped to
this charger, and reads an integer 6-32 A `charge_power` as the charger's
current, dated by the capability. The app's `charge_power_selector` picker
holds a fixed list of currents and is not used.

**P40.** The `keba-p40` driver has no `onoff` and its picker and card accept
no value under 6 A, so the app offers no way to pause a P40. The adapter does
not match it, and without `evcharger_charging` PELS does not list it.

`test/e2e/kebaChargerSdkE2E.test.ts` drives PELS against a model of the app's
switch, poll and card:

- a stop under pressure through `onoff`, then a start when there is room;
- whole-amp reductions through `set_charge_power` with an API key.
