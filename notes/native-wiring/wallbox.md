# Wallbox compatibility

`lib/device/wallbox/` owns the community Wallbox app (`nl.xseth.wallbox`,
`wallbox` driver, Wallbox cloud). Checked against the live 1.2.0 package.

**Start and stop.** The app's `evcharger_charging` listener pauses
(`action: 2`) or resumes (`action: 1`) the session. The app publishes the
switch as `status == Charging`, so a resumed session waiting for a full car,
or for the charger's own schedule, reads off. Its `status` tells these apart:

- `Charging` and `Waiting` are a session PELS lets run.
- `Paused` is one it paused.

The adapter reads the switch from `status` and drops the app's own switch
events.

**Charging current.** The app has no current capability. Its app card
`change_ampere` sets the charger's `maxChargingCurrent` in the Wallbox cloud,
from 1 A to `max_available_current`. The adapter offers it as built-in current
control through the owner's Homey API key, scoped to this charger, like
Futurehome. Every poll publishes the configured maximum on `measure_current`:
10 s after a command, otherwise every 123 s. The adapter reads that value as
the charger's current reading. It is the cloud's answer, not proof the charger
applied it, and it is accepted as Futurehome's saved limit is. The app reports
no phases, so the owner picks the EV phase model.

`test/e2e/wallboxChargerSdkE2E.test.ts` drives PELS against the shipped poll,
pause, resume and card in two cases:

- a pause, then a confirmed resume for a car that finished meanwhile;
- whole-amp reductions through `change_ampere` with an API key.
