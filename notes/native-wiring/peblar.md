# Peblar compatibility

`lib/device/peblar/` owns the community Peblar app (`com.KyleMichiels.Peblar`,
`peblar_charger` driver, local REST). Checked against the live 4.2.8 package.

`peblar_charge_limit` is the charger's live charge limit, `evinterface`
`ChargeCurrentLimit`. It is set in whole amps from 6 A up to the allowed
maximum, which the app declares as the capability maximum. A write PATCHes the
limit and publishes it at once, and every 10 s poll publishes it again.
`evcharger_charging = true` sets the limit to the allowed maximum; `false` sets
it to 0. The app refuses a fourth pause inside ten minutes, and PELS retries a
refused command like any failed one. The app publishes `evcharger_charging`
as limit ≥ 6 A.

The adapter is built with `createCurrentSwitchChargerAdapter`
(`lib/device/currentSwitchCharger.ts`):

- **on** writes 6 A, never the app's full-current switch.
- **off** uses the app's switch.
- The switch is read from the limit.

Phases come from the charger: one when `peblar_force_1_phase` is set, otherwise
three when the meter sees L2 or L3 live (above 50 V).

The official Peblar app (`com.peblar`) is left with start and stop only. Its
`evcharger_limit_current` writes the owner's maximum into the charger's stored
user configuration (`UserDefinedChargeLimitCurrent`), not a live limit. The
live limit is reachable only through its switch, which restores the last limit
or 0.

`test/e2e/peblarChargerSdkE2E.test.ts` drives PELS against the shipped
behaviour on one and three phases. It covers the ladder, reductions, a pause
followed by a safe resume (never the allowed maximum), and staying paused when
6 A does not fit.
