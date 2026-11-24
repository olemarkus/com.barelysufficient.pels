PELS controls EV chargers such as Easee, Zaptec, Alfen, Peblar, Wallbox and Zappi, as well as heating, hot water and home batteries, through their Homey apps. When several appliances need power at once, PELS lowers charging current, adjusts heating or pauses lower-priority devices. It resumes paused devices when more power is available.

After installing, open Homey > More > Apps > PELS > Settings. Guided setup helps you connect your meter and choose a first device. A smart plug that measures power can provide a reading for a compatible device without its own meter. If a device has a separate heating switch, you can choose it for PELS to use.

Capacity limit manages average power over an hour or 15 minutes to reduce tariff peaks. Grid import limit controls the power drawn from the grid right now. Either limit can be used independently, or both together. Measurements come from Homey Energy, a meter reader or Flows.

Main fuse can reduce the load on a phase as it nears its limit. This works on a three-phase connection with neutral and a meter that reports each phase.

In Smart tasks, set a goal and deadline: charge the car to 80% by 07:00, warm the living room before you get home or give your water heater a set amount of energy. PELS prefers lower-priced times that fit the available power. It uses the car’s battery level when Homey provides it. Prices come from Homey Energy, Power by the Hour or Flows, including any time-of-use rates and network charges they provide. Heating and cooling can follow 15-minute prices. Use Schedules to set when tasks are created or modes change. For a scheduled mode change, PELS can start heating ahead of time.

Solar surplus can heat water, warm or cool your home and charge your car. PELS adjusts charging current to the available solar power. In suitable installations, it can also use otherwise unused solar production when export is disabled. Your export price is included in planning, even when it is negative. Usage shows production, self-consumption, export and avoided grid costs.

PELS shares solar surplus between your devices and home batteries in the order you choose. It works with batteries such as Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy and Anker SOLIX. PELS can reduce battery charging when a higher-priority device needs power, discharge the battery to help keep you within your limit, or sell stored energy when you enable it and it lowers your costs. Batteries you let PELS plan work together, so one battery never charges another. If you use Marstek Battery Connector, turn on Local API on your Marstek Venus before pairing it over your home network.

Modes such as Home, Away or Night each keep their own temperatures and device priorities. Flows can switch between them as your routine changes. Daily budget spreads energy use across the day.

Simulation mode previews how devices would be controlled until you choose Start managing at the end of setup.
