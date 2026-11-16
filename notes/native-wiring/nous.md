# Nous Smart Energy Monitor D4Z

`lib/device/nous/` owns the Nous app's three-phase clamp meter
(`net.franceweb.nous`, driver `smart-energy-monitor-d4z`). Behaviour as of
version 2.23.3.

The device publishes each phase with a letter suffix: `measure_power_x`,
`measure_power_y` and `measure_power_z`, with `measure_current_*` and
`measure_voltage_*` beside them, and the whole-home total in `measure_power`.

The adapter reads x, y and z as L1, L2 and L3 under the standard names
(`measure_power.l1`, `measure_current.l1`, `measure_voltage.l1`, ...) through
`meterPhaseNames.ts`, one facet at a time, and names live reports the same way.
A facet is renamed only when all three of its phases are declared. The meter
phase read takes the same view, so the main fuse uses the phases like any other
meter's and the phase tracker checks them against `measure_power`.
