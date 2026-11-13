# Stiebel Eltron heat pump compatibility

`lib/device/stiebel/` owns the Stiebel Eltron Heat Pumps app
(`Stiebel.heatpump`, drivers `heatpump`, `heatpump-wpm3i` and `heatpump-lwz`).
Behaviour as of version 1.5.3. The older `stiebel-heatpump` driver
has no writable hot-water capability and stays one device.

One Homey device holds two loads:

- **Room heating:** `target_temperature` (5-30 °C, or 10-30 °C on the LWZ) and
  `measure_temperature`.
- **Hot water:** `target_temperature.warmwater_temp` (10-60 °C, step 0.1) and
  `measure_temperature.warmwater_temp` on `heatpump` and `heatpump-wpm3i`;
  `target_temperature.warmwater` (10-55 °C, step 0.5) and
  `measure_temperature.warmwater` on `heatpump-lwz`. A write sets the hot-water
  comfort temperature, and the app's poll publishes it back on the same
  capability.
- **Power:** `measure_power` is the total, `measure_power.heating` and
  `measure_power.warmwater` its parts; `meter_power` likewise. All of them are
  approximated from the app's daily energy counters, which the app reads only
  when the owner turns on the **ISG supports community registers** setting
  (`has_community_registers`). Without it they have no value.

## Two devices

When a read declares the hot-water pair, `projectRead` returns two views:

- The room view keeps the Homey id and every capability. Where the heating
  part is declared it is the view's `measure_power` / `meter_power`, and the
  total moves to `measure_power.total` / `meter_power.total`, which nothing
  reads. The hot-water capabilities it still declares are read by nothing on
  it.
- The hot-water view is `<homeyId>~hot_water`, class `heater`, named
  "`<device name>` hot water". It declares only the hot-water pair as
  `target_temperature` / `measure_temperature` and the hot-water part as
  `measure_power` / `meter_power`.

A part with no value leaves its view without power. The total is never copied
onto a view, so whole-home attribution counts each watt once.

`routeReport` sends a live report of the hot-water pair or part to the
hot-water view under its standard name, the heating part to the room's power,
and the total to `measure_power.total`. A setpoint write on the hot-water view
goes to the Homey device's hot-water setpoint (`capabilityWrite`,
`sourceDeviceId`), and its echo is matched under the Homey device before it is
routed. The room view's writes are unchanged.

## Known limits

- The room view's learned power peak was learned on the total, so it reads high
  until PELS relearns it on the heating part.
- The weather picker reads a temperature source by Homey id, so the hot-water
  view is not offered as one.
- The controlled-energy backfill reads history by Homey id and counts the whole
  heat pump under the room view.
