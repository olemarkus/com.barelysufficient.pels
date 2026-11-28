---
title: Solar and Self-Consumption
description: Use more of your own rooftop solar with PELS, with capacity protection, surplus to heating, on/off devices and EV charging, and honest accounting under export.
---

# Solar and Self-Consumption

If you have rooftop solar (PV), this page explains what PELS does with it today.

**Short version:** your solar protects your capacity for free, and PELS puts your surplus to work: it raises a heater's target, runs an on/off load such as a pool pump only while you export, or matches an EV charger's current to your surplus, instead of sending it to the grid. With a home battery, your surplus goes down your priority order, the battery included, and when your home nears its limit the battery discharges on its turn. Left last in the list, the default, your devices get the sun first and the battery covers your whole home before any device is limited. PELS also shows what your solar did: production, self-consumption, export, and the grid cost it avoided.

::: tip Check the whole-home meter
Check that **Overview** shows net grid import and that the reading goes negative when your home exports. With the **Flow card** power source, send that signed reading in watts to **Report power usage**. If the meter reports import and export separately, send `import − export`.

PELS offers surplus controls once it has seen export. If your inverter prevents export, use **Power meter** and check that Homey Energy shows your solar production. With those readings PELS can also offer surplus controls when it detects that the inverter is holding back production. [Zero-export setup](#zero-export-setup).
:::

## What to do today

To use more of your own solar with PELS:

1. **Confirm PELS can see your export** — on the Power meter source, that your solar device's production shows up in Homey Energy; on the Flow source, that the reading you send goes negative while exporting. Capacity protection then works automatically — there is nothing else to turn on.
2. **Optionally turn on "Use solar surplus"** on a managed heating device (a water tank, floor heating, or a room heater) so surplus warms your home instead of going to the grid.
3. **Keep an EV charger managed with current control.** While the sun is up, a charging car naturally uses the freed-up power, so much of that charge comes from your own solar. To match charging current to export, turn on **Charge on solar surplus** on the charger. Choose **Turn off** under **Power limiting** if it should stop when surplus is too low.

How much this helps depends on your home and the weather.

## What PELS does with solar today

### Capacity protection just works

PELS watches your **net** grid power. When your panels cover part of the load, your net draw is lower, so there is more available power and PELS limits your managed devices less — exactly when the sun is out. This follows from how PELS measures power; there is nothing to turn on. See [Solar Accounting](./technical.md#solar-accounting).

Where exported solar earns roughly the spot price, self-consumption is a modest gain, and the bigger win from panels is this automatic capacity protection. Where exported energy earns little, or costs you (see below), using your own solar matters much more.

### Use solar surplus to heat your home

On a managed heating device you can turn on **"Use solar surplus"**. When you are exporting enough to cover that device's own draw, PELS raises its target by the **"Solar-surplus boost"** amount (in °C, default +2), so the surplus warms your home or water instead of going to the grid. A small or short-lived export may not be enough to engage it.

![The "Use solar surplus" toggle in a managed device's detail page](/screenshots/device-detail/solar-surplus-toggle.png)
*Figure 1. Turn on "Use solar surplus" on a managed heating device.*

![The "Solar surplus" boost setting, raising the target by 2 °C while exporting](/screenshots/device-detail/solar-surplus-boost.png)
*Figure 2. "Solar-surplus boost" sets how much to lift the target while you are exporting.*

This boost:

- yields to your hard cap and daily budget — capacity protection always comes first, and the boost's energy counts toward your daily budget like any other use;
- works on any managed device with a temperature target (a water heater, floor heating, or a thermostat) that has a target set for the current mode;
- is a small, fixed step — once the room or tank reaches the raised target, the device stops drawing and any further surplus is exported.

PELS waits for the surplus to settle before engaging, and — to avoid flapping on passing clouds — it briefly holds the raised target for a few minutes after export stops before easing back. While the boost is engaged it takes precedence over any price-based lowering (your own solar is free); the rest of the time your normal price-based targets apply. It is a gentle "use a bit more of my own solar" nudge, not a precise export-to-zero controller.

<span id="zero-export-setup"></span>

**If your inverter is set to zero export**, choose the **Power meter** source so PELS can compare production and grid import measured at the same instant. Under **Settings > Electricity prices > Solar forecast**, **Automatic** uses Homey’s solar forecast when available. Otherwise, PELS uses the forecast it learns over several weeks of production history.

When actual production is below the forecast and the home is drawing little from the grid, PELS can raise the heating target to use the available solar power. If grid import rises, PELS backs off and waits before trying again. The enabled limits still apply. This estimate is disabled in homes with a battery, where charging the battery can look like the inverter holding back production.

### Run an on/off device only on solar surplus

On a managed **on/off** device you can turn on **"Run on solar surplus"**. PELS then keeps the device **off** and turns it on only while your export comfortably covers its draw — the same settle-and-hold behaviour as the heating boost, so passing clouds don't flap it. When the surplus is gone, PELS turns it off again.

Before you use it:

- **If you switch the device on yourself while there is no surplus, PELS will switch it off again.** The toggle hands the on/off decision to PELS; turn the toggle off to take the device back.
- **Turning the toggle off while the device is off:** PELS then treats it like any other managed device and starts it when there is room, from the grid if needed. To keep it off instead, also turn on **Leave off until turned on again** for the device ([Configuration](/configuration#leave-off-until-turned-on-again)); it then stays off until it is turned on, even if you turn the toggle back on.
- **Use it for loads that can wait for the sun**: a pool pump, a towel dryer, a garage or cabin heater.

::: warning Not for your only water heater
Through a run of cloudy days a device set to run on solar surplus never turns on, and a tank that never heats is a comfort (and hygiene) problem. Turn the toggle off if the device must run regardless of weather.
:::

The device shows **"Waiting for solar surplus"** on its card while PELS keeps it off, and **"On to use your solar power"** while running on your export. Devices with an active [smart task](./smart-tasks.md) are not held — the smart task's schedule wins.

### Charge a car on solar surplus

On a managed device with **levels** (an EV charger with an **Automatic** or EV control model, or any device you configured as a stepped load) you can turn on **"Charge on solar surplus"** (a charger) or **"Match solar surplus"** (anything else). PELS then picks the level your export covers and moves it up and down as the sun changes, instead of running the device as hard as your hard cap allows.

The surplus must cover the lowest usable charging current. The default minimum of **6 A** takes about **1.4 kW** on one phase or **4.1 kW** on three phases with a 400 V supply. A higher minimum for the charger or connected car needs more surplus. Under **Power limiting**, choose **Turn off** if charging should stop when surplus falls below that minimum. With **Set to step**, the charger can keep running at the selected step and draw the difference from the grid.

Some things to know:

- **Your hard cap and daily budget still come first.** The surplus setting can only ever lower the level PELS would otherwise pick, never raise it past a capacity decision.
- **A smart task wins.** If the device has a [smart task](./smart-tasks.md) with a deadline, the task's schedule decides while it is running — a deadline you asked for is not something "use only your own sun" should quietly miss.
- **It moves in steps, not smoothly**, and it waits a couple of minutes between increases so a passing cloud does not change your charging current every few seconds. Decreases are immediate.
- The card reads **"Waiting for solar surplus"** while PELS is holding the device back.

### Big flexible loads use the freed-up power

A managed device that is *not* set to match your surplus runs as hard as it can — an EV charger with current control takes up the room solar frees, up to your hard cap. So if a car is charging while the sun is up, much of that draw comes from your own solar rather than the grid.

PELS runs these loads to **available power up to your hard cap**, not matched to your surplus — so a large load can keep running (drawing from the grid) past the point the sun alone would cover, and charging after dark pulls entirely from the grid. If that is not what you want, the surplus setting above is how you change it.

### Your accounting stays honest under export

When you export, PELS still uses net grid import for the **hard cap**, the **daily budget**, and your usage totals. An export hour is treated as zero energy used, so it never subtracts below zero or distorts your budget. Where your device meters show usage your panels covered locally, the managed/background split is labelled **"Before solar:"**. See [Daily Energy Budget](./daily-budget.md).

### See what your solar does

The **Usage tab** shows a Solar card with today's numbers so far — **Produced**, **Used at home** (kWh and the share of production you consumed yourself), and **Exported** — plus a compact previous-days view. When electricity prices are configured, the card also shows **Grid cost avoided today** (what the self-consumed energy would have cost to import) and, once an export price is set under **Settings > Electricity prices**, **Earned from export today**. The two figures cover different energy — what you used yourself versus what you sent out — so they are shown side by side, never summed into one "savings" number. Money figures are estimates (`≈`), and a value where some hours have no price yet says so.

The Usage hero's headline still counts what you drew **from the grid**, so on a sunny day it can look surprisingly small next to the Solar card. The hero adds a "+ 1.5 kWh of your own solar" line naming the energy your panels covered locally — the grid never saw it, so it is not in the headline number.

While the sun is up, the **Overview** hero adds a live line under Power now — for example *"Solar now 3.2 kW · 1.1 kW at home, 2.1 kW exported"* — so you can see at a glance where your production is going right now. While you export, "Power now" (your net grid power) can legitimately read negative; this line is what makes that reading make sense.

Three honest edges to know about:

- **Battery homes:** Exported can be *higher* than Produced in some hours — a battery discharging to the grid exports stored energy on top of (or instead of) live production. The card notes this rather than hiding it.
- **A meter without a production reading** (your export is visible but no solar device reports production): the card falls back to an export-only view and never pretends to know your production. This applies on either power source — what decides it is whether a solar device reports production, not how your meter reading reaches PELS.
- **A Flow that reports on a timer:** on the Flow power source, PELS counts your export from the readings your Flow sends, and between two readings it assumes the last one still holds, exactly as it does for the power you import. If your Flow reports only every few minutes, export in the Solar card is only as precise as that: a cloud that stops your export right after a reading is not seen until the next one. Your production is not affected, because PELS reads it from Homey every 10 seconds. For accurate export, send your meter reading whenever it changes rather than on a fixed interval.

### Avoid paying to export

If your contract charges you for exported electricity during some periods, turn
on **Use an export price** under **Settings > Electricity prices**, enter your
contract's per-kWh export value, and select compatible inverters under **Avoid
paying to export**. Include export fees and credits that change with each kWh.
Monthly fees do not belong in this amount.

PELS reduces excess production while the export price is below zero and lets
production rise when household demand increases. Solar-surplus loads get time to
start before PELS reduces the remaining excess. When the export price is zero,
positive, or unavailable, or you turn the inverter's switch off, PELS returns it
to its previous limit and mode. An existing production limit remains the ceiling.
It also returns control on meter silence and retries an interrupted hand-back.
After a restart, hand-back resumes when PELS has a meter reading, including a
reading restored from before the restart. Simulation mode never starts curtailment.

If an inverter app changes its control range or mode options, PELS hands back
production without writing an old mode value. It restores the prior production
ceiling within the new range; an autonomous mode's dormant zero setpoint does
not stop production. Small power changes stay inside a deadband to avoid
repeated limit writes.

If you change the inverter's control mode in its own app while PELS holds it,
PELS turns its switch off and leaves your chosen mode in charge.

The inverter's Homey app needs to offer the standard writable `target_power`
production limit, a maximum output, and production readings. PELS uses these
controls directly; no Flows are needed. Inverters whose app offers only
proprietary actions are not listed. The SMA Modbus app's persistent power
setting is excluded from live control.

This follows the **export price**, not the spot price or import price. Use the
value your contract actually settles for an extra exported kWh, including any
feed-in fee. Control follows meter readings
and inverter response, so brief export can occur.

### Home batteries

PELS makes your home battery part of your priority list. Your sun goes to your devices and the battery in the order you choose, and when your home nears its limit, the battery takes its turn: PELS caps its charge, then has it discharge to cover the peak. Left last in the list, the default, the battery covers your whole home before a single device is turned down. For a full walkthrough with a sunny day and an evening, see [Solar and a home battery](./use-cases/homey-solar-home-battery.md).

<figure class="docs-figure">
  <img class="docs-screenshot" src="/screenshots/battery/overview-supplying.png" alt="PELS Overview with the hero line Sessy battery is supplying 2.4 kW to hold your limit, and the battery card reading Supplying 2.4 kW, 62 % charged, Holding your limit so your devices keep running." />
  <figcaption>The Overview while the battery holds your limit.</figcaption>
</figure>

**What it works with.** PELS works with a home battery whose Homey app lets Homey set how much it charges or discharges, and offers a Homey or API control mode. Sessy, Marstek Venus, Anker SOLIX, Zinvolt, AlphaESS, SOLARWATT and SolarEdge (through its Modbus app) are examples. A Sessy needs its local login in the Sessy Homey app, so PELS can switch it to API control. HomeWizard Plug-In Batteries appear in PELS as one battery, named after the P1 meter that steers them: PELS sets the group's mode, and the batteries' own devices do not appear separately.

**Batteries controlled through their app's Flow cards.** A Marstek Venus paired with the Marstek Battery Connector app (its local connection), a Sigenergy system, a Zendure SolarFlow paired with the local Zendure app, a Huawei LUNA2000 paired with the FusionSolar app over Modbus, a SolaX battery paired with the SolaX Inverter Modbus app, and a Fronius GEN24 battery paired with the Fronius Control app take commands only through their app's own Flow action cards. PELS runs those cards itself, with a Homey API key with **Flow** permission: the same key built-in charger current uses. Create it with [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro) and save it in PELS in the **Battery** section of the battery's device page, where you can also check, replace or remove it later. One key works for every device on this Homey. Until a key is saved, the battery's card reads `PELS can only watch it: add a Homey API key so it can help with your limit and solar`. A Sigenergy battery is controlled through its plant, so pair the plant device in the Sigenergy app as well. A LUNA2000 runs PELS's commands as forced charge and discharge runs of 10 minutes, which PELS renews while it needs the battery. A SolaX battery is controlled through the inverter it follows, so keep that inverter paired in the SolaX app; PELS sets the battery's power through the inverter's remote control, which stays in its memory only, and hands it back to the inverter's own work mode. The inverter's G4, G4 Pro, X1-VAST, X3-IES and X3-Ultra drivers offer that control. If the inverter refuses PELS's commands, turn on **Auto unlock** in its device settings. A Fronius GEN24 battery needs **Battery max charge/discharge (kW)** filled in under its device settings in the Fronius Control app. PELS sets it in steps of 300 W and waits five minutes before lowering its discharge or raising its charge, so the inverter gets few commands; it raises discharge at once when your limit needs it. While PELS holds it idle, the battery can still charge from your solar. A Zendure on its local app has no mode of its own to return to, so PELS hands it back at 0 W, and your own flows take it from there. These apps report no control mode back to Homey, so a change you make in the battery's own app while PELS holds it is not seen, and PELS's next command replaces it: turn off **Managed by PELS** or **Power-limit control** to take the battery back.

**A managed device like any other.** The battery has a card on the Overview, a row in the device list and its own device page. The card leads with what the battery is doing (`Supplying`, `Selling to grid`, `Charging`, `Limited · Charging` or `Own mode`), shows how full it is, and gives one reason line, such as `Holding your limit so your devices keep running`. While the battery holds your limit, the Overview hero says so: `Sessy battery is supplying 2.4 kW to hold your limit.`

**Choose how PELS uses your battery.** PELS controls a managed battery in its Homey or API mode. With battery planning off, it charges from spare solar in priority order, discharges when its turn comes to hold your power limit, and idles the rest of the time.

Turn on **Plan charging with PELS** on the battery's device page to let PELS plan charging and household supply continuously. Enter usable capacity and minimum reserve; under **Losses and battery wear**, set efficiency and a wear allowance in your electricity price unit. PELS measures the battery's round-trip efficiency from its own full charge cycles and shows the result beside the efficiency field, with **Use** to fill it in; the plan keeps using the value you saved. PELS uses published import and export prices, expected household demand, solar forecasts and smart-task commitments to choose how much energy to store. The page shows expected charge levels and charging periods. In a period where the battery supplies the house, it covers what the house actually draws, also when that is more than expected, down to your reserve. PELS retains control between periods, including at zero power, and replans as inputs change. Your reserve, power limits and device priorities still apply. Turning planning off returns to solar charging and power-limit protection. Continuous planning covers the batteries in the Main home.

Turn on **Pause scheduled discharge for EV Smart tasks** on a battery you want
to preserve while an EV Smart task can charge. This pauses scheduled household
supply and sales during EV charging periods, including when the car is waiting
for available power. The battery can still charge and help hold your home's power
limits. The battery plan preview shows what it would do without this live pause.

With planning on for several batteries, PELS plans them together in your priority order. The highest-priority battery plans first, and each next one covers what the ones before it leave: household demand they did not supply, charging room they did not use, and demand above your power limit they could not cover. In each planned period the batteries either all charge or all supply, so no battery charges from another, and a battery that keeps its energy for home use never supplies more than the house uses. Each battery keeps its own capacity, reserve, efficiency, wear allowance and selling choice. If a battery delivers less than its plan asks, PELS learns what it can deliver and the next plan gives the rest to your other batteries. A battery PELS cannot control is left out of the plan, and the others plan for the house. To have a different battery go first, change the order in your priority list.

Without an export price, the plan still runs. It counts solar sent to the grid as worth nothing, so it stores what the battery can take, and the battery page says so. Set an export price under **Settings > Electricity prices** so the plan can weigh storing solar against exporting it.

**Sell stored solar in the evening.** When midday export pays little and evening export pays more, the solar your battery stored can earn more on the grid later than at noon. Turn on **Sell stored energy when profitable** under **Plan charging with PELS**, and enter an **Export limit at your meter** in kW: the most power the house may send to the grid while the battery sells. PELS compares a plan that sells with one that keeps the energy for your home, both ending with the same charge, after losses and wear, and sells only when that lowers your electricity cost. It never sells below your minimum reserve, and only in hours where export pays more than zero. Selling also works without solar: on a day with a large price spread, PELS can charge in a cheap hour and sell when export pays enough to cover the losses and wear.

Selling needs an export price for every hour of the plan. Until every hour has one, PELS keeps planning for your home and the battery page says that selling is waiting. The page shows sales as `Sell to grid` windows and gives the estimated cost reduction against keeping the energy for your home, over the hours shown. This is an estimate from published prices and forecasts, not a record of what you earned. The house comes first in each hour: the battery covers your home's measured use, and only the rest goes to the grid, up to your export limit. While the battery sells, its card reads `Selling to grid` · `Selling stored energy while export pays more`; it reads `Selling to grid` only while the battery discharges and your meter shows export at the same time. Selling never frees up power for other devices: PELS does not restore a device, or start one on solar surplus, on energy the battery is selling. Your power limit, daily budget and smart tasks keep their priority over selling.

If panels belong to both Main and another meter area, the aggregate solar forecast cannot separate Main's production. The battery page explains that planning needs a forecast for Main. Panels outside Main do not count as Main's solar.

**Solar surplus follows your priority order.** Your surplus goes down the list to your devices and batteries, and only what is left goes to the grid. With the battery last, your devices get the sun first, then the battery, then the grid. PELS counts what the battery is already storing as surplus for the devices above it: when a device set to use surplus (a heater with **Use solar surplus**, an on/off device with **Run on solar surplus**, or a charger with **Charge on solar surplus**) ranks above the battery and is waiting to start, PELS lowers the battery's charge so the device can run. A battery above a device keeps its charge, and the device gets what the battery leaves. Stored energy is never spent on surplus: PELS only moves solar you would otherwise export, so sharing it never takes your home over its limit.

**The battery holds your limit on its turn.** When your home goes over its limit, whether that is the capacity limit or your daily budget pace, PELS limits in priority order, from the bottom of the list up. When the battery's turn comes, PELS first caps its charge, then asks it to discharge enough to cover the rest. Devices below the battery are limited before it, and its discharge protects every device above it. Grid charging counts against your limit and your daily budget like any other load, so a battery that starts its own cheap-hour charging while your car charges is capped before the car is slowed. An empty battery, or one that does not follow, delivers nothing, and PELS moves straight on to the next device.

**Bringing it back.** After a limit, the battery comes back like any device: in your priority order, once your home has room for it to charge again. PELS resumes charging from surplus or follows its price plan when one is available. A full battery can wait for its next job while PELS keeps control.

**You stay in charge.** On the battery's device page:

<figure class="docs-figure">
  <img class="docs-screenshot" src="/screenshots/battery/device-page.png" alt="PELS device page for a Sessy battery: Supplying 2.4 kW, Managed by PELS on, Power-limit control on, Priority 9 of 9 in Home with a Reorder button." />
  <figcaption>The battery's device page.</figcaption>
</figure>

- **Managed by PELS** is the battery's main switch. Off, PELS hands the battery back and leaves it alone.
- **Power-limit control** is on by default for a battery PELS can drive. Off, PELS never takes the battery over: no charge cap, no call on it for your limit, and no steering of its charge for your solar. Its own app stays in charge, PELS still counts its power and charge level, and its card reads `Power-limit control is off: its own app is in charge`. The **Enable power-limit control for device** and **Disable power-limit control for device** Flow cards work on batteries too.
- **Priority** shows the battery's place in the current mode, and **Reorder** moves it.

If you change the battery's mode in its own app while PELS holds it, PELS takes that as your decision: it turns **Managed by PELS** off for that battery, says so on its device page and in the device list, and leaves it alone until you turn it on again.

PELS also hands the battery back at once if your meter stops reporting or the battery stops responding, and after a restart PELS resumes control for eligible batteries once meter readings return. If the meter stays silent, it hands the battery back. If you uninstall PELS while it holds the battery, switch the battery's mode back in its own app. A battery in a [meter area](/meter-areas) keeps its own mode, and Simulation mode leaves every battery in its own mode too.

## Export pricing

PELS lets you tell it what exported power is worth to you, so its solar and battery plans weigh using your solar at home against sending it to the grid. Under **Settings > Electricity prices**, turn on **"Use an export price"** (the section appears once PELS can see your solar, meaning a managed solar device reports production or your meter has recorded about a kilowatt-hour of grid export, or once you have a home battery PELS can drive, and stays visible if you already have an export price configured).

If your electricity prices come from **Homey Energy** or **Power by the Hour**, you can then set **Where the price comes from**:

- **Homey Energy**: PELS uses the feed-in price you already set up in Homey under **Energy > Electricity**. That can be a fixed amount, or a formula that follows the hourly price, which is how most dynamic contracts pay for exported power. Nothing to retype. See [Getting paid for solar you export](/homey-energy#getting-paid-for-solar-you-export).
- **Power by the Hour**: PELS uses the feed-in price that app publishes for each period, after the export markups you set on its price device. Without any export markup there, it equals the import price.

On Homey Energy with Power by the Hour installed and a price device in it, the export section offers **Use Power by the Hour** while you have no export price or only amounts you entered: it makes Power by the Hour your price source for import and export, so your export price follows the market price.
- **Amounts I enter here**: the two amounts below. This is the default.

On the other price sources, or with **Amounts I enter here**, enter what your power company pays you:

- **Share of spot price** — how much of the hourly spot price (incl. VAT) you are paid per exported kWh, as a percentage. Available on the Norway price source, which has an hourly spot price; if your contract pays the raw spot price, enter 80.
- **Fixed amount** — added for every exported kWh, in the same unit as your other prices. It can be negative if you pay to export. On the Flow, Homey Energy and Power by the Hour price sources this fixed amount is the whole export price, since no hourly spot price is available there. On Homey Energy or Power by the Hour, choose that source above instead if your feed-in price follows the hour.

Once it is on:

- the **Budget tab** shows **"Export price now"** — the current hour's export price;
- scheduling uses it through the **planning price**: in hours where PELS expects your solar surplus to cover flexible load, it plans against what that energy is actually worth to you (the export price) rather than the import price — steering flexible load such as deadline EV charging into sunny hours. The cheap, normal and expensive price levels, and the cheap-hour boost and expensive-hour reduction that follow them, stay on the import price; to put your surplus to use directly, see [What PELS does with solar today](#what-pels-does-with-solar-today).

Your money figures stay honest: receipts, usage costs, and the budget's money view remain on the import price you are billed, so they reconcile with your invoice.

## See also

- [Technical Reference — Solar Accounting](./technical.md#solar-accounting)
- [Daily Energy Budget](./daily-budget.md)
- [Cost-Saving Functions](./cost-saving-functions.md)
- [Configure an EV Charger](./ev-charger.md)
- [Smart Tasks](./smart-tasks.md)
- [Solar and a home battery](./use-cases/homey-solar-home-battery.md)
