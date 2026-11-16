# LiXee ZLinky_TIC

`lib/device/lixee/` owns the LiXee app's Linky reader (`com.lixee`, driver
`zlinky_tic`). Behaviour as of version 1.5.4.

On a three-phase Linky the device publishes each phase's apparent power in
`phase_1_apparent_power_capability`, `phase_2_apparent_power_capability` and
`phase_3_apparent_power_capability`, beside the whole-home `measure_power`. A
single-phase Linky has none of the three.

The adapter reads the three as `measure_power.l1` to `measure_power.l3`
(`projectRead`, through `meterPhaseNames.ts`) and names live reports the same
way (`routeReport`). Only a read that declares all three is renamed. The meter
phase read takes the same view, so the main fuse sees the phases like any other
meter's and the phase tracker checks them against `measure_power`. The values
are apparent power in VA, which is what the Linky compares with the subscribed
power. The device's other capabilities are read as Homey reports them.
