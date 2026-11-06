# Zappi compatibility

`lib/device/myenergi/` owns the Zappi driver of the community myenergi app
(`net.biseth.myenergi`, `zappi` driver, myenergi cloud). Checked against the
live 2.4.18 package.

A Zappi has no current a Homey app can set; myenergi's API offers charge modes.
PELS switches it on and off. The app's `onoff` and `evcharger_charging`
listeners do the same thing: charge mode Off, or the owner's last mode. The app
publishes them differently:

- `onoff` is the charge mode, on unless Off.
- `evcharger_charging` is whether a car draws now. A full car, a car waiting
  to start, or Eco/Eco+ waiting for solar never is.

The adapter writes `onoff` and reads the charging switch from it, dated by it.
The app's own switch events are dropped.

`test/e2e/zappiChargerSdkE2E.test.ts` covers two cases. In the first, a Fast
session is stopped under pressure and started again in the owner's mode,
confirmed. In the second, a start in Eco+ with no solar is confirmed without
the reachability back-off. Without the adapter that Eco+ start never confirms,
and PELS sends it again and again.
