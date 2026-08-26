---
title: Solar and Self-Consumption
description: Use more of your own rooftop solar with PELS — automatic capacity protection, a surplus heating boost, and honest accounting under export.
---

# Solar and Self-Consumption

If you have rooftop solar (PV), this page explains what PELS does with it today.

**Short version:** PELS uses your solar to protect your capacity for free; it can nudge a heater to soak surplus, run an on/off load such as a pool pump only while you export, or match an EV charger's current to your surplus — instead of sending it to the grid; and it shows what your solar did — production, self-consumption, export, and the grid cost it avoided. It does not yet drive your export to zero or control a battery or inverter (see [What PELS does not do yet](#what-pels-does-not-do-yet)).

::: warning Needs a signal that you export
The solar features below need a signal that you are exporting — either a solar device that reports production, or a meter that shows your solar export.

On the **Power meter** power source (read through Homey Energy) both signals are available, and every feature on this page works.

On the **Flow** power source, send your meter's reading to the "Report power usage" card exactly as your meter gives it: if it reports a signed value, a negative reading means you are exporting, and PELS reads it as export. If your meter is published as two separate devices — one for import, one for export — send `import − export` so the number you report can go negative. Everything on this page works here too: capacity protection, the export accounting below, your panels' production, the heating surplus boost, and running an on/off device on surplus.

Two things follow from PELS only knowing what you send it. The surplus controls — the heating boost and running an on/off device on surplus — stay hidden until PELS has actually seen your home export, and appear on their own once it has; a reading that never goes negative simply leaves those devices running as usual. And the Solar card says so: while production is measured but export never has been, it shows a note asking you to check that the reading turns negative while you export. The one thing that stays Power-meter-only is the estimate PELS makes for a **zero-export inverter** (described below), which needs your production and your meter reading to be taken at the same instant.
:::

## What to do today

To use more of your own solar with PELS:

1. **Confirm PELS can see your export** — on the Power meter source, that your solar device's production shows up in Homey Energy; on the Flow source, that the reading you send goes negative while exporting. Capacity protection then works automatically — there is nothing else to turn on.
2. **Optionally turn on "Use solar surplus"** on a managed heating device (a water tank, floor heating, or a room heater) so surplus warms your home instead of going to the grid.
3. **Keep an EV charger managed with current control.** While the sun is up, a charging car naturally uses the freed-up power, so much of that charge comes from your own solar. To go further and charge *only* on the sun, turn on **"Charge on solar surplus"** on the charger.

How much this helps depends on your home and the weather — it lowers your export modestly and automatically. A precise "use every watt" maximiser is a future direction, not a setting today.

## What PELS does with solar today

### Capacity protection just works

PELS watches your **net** grid power. When your panels cover part of the load, your net draw is lower, so there is more available power and PELS limits your managed devices less — exactly when the sun is out. This follows from how PELS measures power; there is nothing to turn on. See [Solar Accounting](./technical.md#solar-accounting).

In Norway, exported solar still earns roughly the spot price, so self-consumption is a modest gain — here the bigger win from panels is this automatic capacity protection. Where exported energy earns little, or costs you (see below), using your own solar matters much more.

### Use solar surplus to heat your home

On a managed heating device you can turn on **"Use solar surplus"** (the toggle appears once PELS can see your solar — either a solar device reports production, or your meter has shown solar export, which covers a string inverter with no separate solar device). When you are exporting enough to cover that device's own draw, PELS raises its target by the **"Solar-surplus boost"** amount (in °C, default +2), so the surplus warms your home or water instead of going to the grid. A small or short-lived export may not be enough to engage it.

![The "Use solar surplus" toggle in a managed device's detail page](/screenshots/device-detail/solar-surplus-toggle.png)
*Figure 1. Turn on "Use solar surplus" on a managed heating device.*

![The "Solar surplus" boost setting, raising the target by 2 °C while exporting](/screenshots/device-detail/solar-surplus-boost.png)
*Figure 2. "Solar-surplus boost" sets how much to lift the target while you are exporting.*

This boost:

- yields to your hard cap and daily budget — capacity protection always comes first, and the boost's energy counts toward your daily budget like any other use;
- works on any managed device with a temperature target (a water heater, floor heating, or a thermostat) that has a target set for the current mode;
- is a small, fixed step — once the room or tank reaches the raised target, the device stops drawing and any further surplus is exported.

PELS waits for the surplus to settle before engaging, and — to avoid flapping on passing clouds — it briefly holds the raised target for a few minutes after export stops before easing back. While the boost is engaged it takes precedence over any price-based lowering (your own solar is free); the rest of the time your normal price-based targets apply. It is a gentle "use a bit more of my own solar" nudge, not a precise export-to-zero controller.

**If your inverter is set to zero export** (it throttles production so nothing is sent to the grid), the meter never shows a surplus — so PELS estimates one instead. This estimate needs the **Power meter** power source: it compares your production against your meter reading, and only that source takes the two at the same instant. It learns your panels' potential in the current weather from your own production history and verifies it against real production: when actual production sits clearly below that potential, the same boost can engage to soak up the hidden surplus, and your inverter naturally produces more to cover it. If production does not follow — your home starts drawing from the grid instead — PELS eases the boost back promptly and waits a while before trying again. This estimate needs some weeks of production history before it can engage, it stays cautious (it backs off whenever your home draws meaningfully from the grid — only the small standing draw of a couple hundred watts that zero-export setups normally show is tolerated — and your hard cap and daily budget still come first), and it is disabled when a home battery is present, since PELS cannot tell a throttled inverter from a charging battery.

### Run an on/off device only on solar surplus

On a managed **on/off** device you can turn on **"Run on solar surplus"** (the toggle appears once PELS can see your solar — either a solar device reports production, or your meter has shown solar export). PELS then keeps the device **off** and turns it on only while your export comfortably covers its draw — the same settle-and-hold behaviour as the heating boost, so passing clouds don't flap it. When the surplus is gone, PELS turns it off again.

Before you use it:

- **If you switch the device on yourself while there is no surplus, PELS will switch it off again.** The toggle hands the on/off decision to PELS; turn the toggle off to take the device back.
- **Use it for loads that can wait for the sun**: a pool pump, a towel dryer, a garage or cabin heater.

::: warning Not for your only water heater
Through a run of cloudy days a device set to run on solar surplus never turns on, and a tank that never heats is a comfort (and hygiene) problem. Turn the toggle off if the device must run regardless of weather.
:::

The device shows **"Waiting for solar surplus"** on its card while PELS keeps it off, and **"On to use your solar power"** while running on your export. Devices with an active [smart task](./smart-tasks.md) are not held — the smart task's schedule wins.

### Charge a car on solar surplus

On a managed device with **levels** — an EV charger set to an EV control mode, or any device you configured as a stepped load — you can turn on **"Charge on solar surplus"** (a charger) or **"Match solar surplus"** (anything else). PELS then picks the level your export covers and moves it up and down as the sun changes, instead of running the device as hard as your hard cap allows.

For an EV charger this is the "leave it plugged in all week" setting: the car charges on the sun, and stops when the sun stops.

::: warning There is no level between off and 6 A
A charger's lowest usable current is **6 A** — about **1.4 kW** on one phase, about **4.1 kW** on three. Below that there is nothing to select, so PELS asks you what to do when your surplus falls short, under **"When surplus runs out"**:

- **Stop** (the default) — charging stops. Nothing is ever drawn from the grid on this setting's account.
- **Keep going at the lowest level** — charging continues at that lowest current and the grid covers whatever the sun does not. On a three-phase charger that can be over 4 kW of grid import, so pick it deliberately.
:::

Some things to know:

- **Your hard cap and daily budget still come first.** The surplus setting can only ever lower the level PELS would otherwise pick, never raise it past a capacity decision.
- **A smart task wins.** If the device has a [smart task](./smart-tasks.md) with a deadline, the task's schedule decides while it is running — a deadline you asked for is not something "use only your own sun" should quietly miss.
- **It moves in steps, not smoothly**, and it waits a couple of minutes between increases so a passing cloud does not change your charging current every few seconds. Decreases are immediate.
- The card reads **"Waiting for solar surplus"** while a device on the **Stop** setting is held off.

### Big flexible loads use the freed-up power

A managed device that is *not* set to match your surplus runs as hard as it can — an EV charger with current control takes up the room solar frees, up to your hard cap. So if a car is charging while the sun is up, much of that draw comes from your own solar rather than the grid.

PELS runs these loads to **available power up to your hard cap**, not matched to your surplus — so a large load can keep running (drawing from the grid) past the point the sun alone would cover, and charging after dark pulls entirely from the grid. If that is not what you want, the surplus setting above is how you change it.

### Your accounting stays honest under export

When you export, PELS still uses net grid import for the **hard cap**, the **daily budget**, and your usage totals. An export hour is treated as zero energy used, so it never subtracts below zero or distorts your budget. Where your device meters show usage your panels covered locally, the managed/background split is labelled **"Before solar:"**. See [Daily Energy Budget](./daily-budget.md).

### See what your solar does

The **Usage tab** shows a Solar card with today's numbers so far — **Produced**, **Used at home** (kWh and the share of production you consumed yourself), and **Exported** — plus a compact previous-days view. When electricity prices are configured, the card also shows **Grid cost avoided today** (what the self-consumed energy would have cost to import) and, once an export price is set under Settings → Electricity prices, **Earned from export today**. The two figures cover different energy — what you used yourself versus what you sent out — so they are shown side by side, never summed into one "savings" number. Money figures are estimates (`≈`), and a value where some hours have no price yet says so.

The Usage hero's headline still counts what you drew **from the grid**, so on a sunny day it can look surprisingly small next to the Solar card. The hero adds a "+ 1.5 kWh of your own solar" line naming the energy your panels covered locally — the grid never saw it, so it is not in the headline number.

While the sun is up, the **Overview** hero adds a live line under Power now — for example *"Solar now 3.2 kW — 1.1 kW at home, 2.1 kW exported"* — so you can see at a glance where your production is going right now. While you export, "Power now" (your net grid power) can legitimately read negative; this line is what makes that reading make sense.

Two honest edges to know about:

- **Battery homes:** Exported can be *higher* than Produced in some hours — a battery discharging to the grid exports stored energy on top of (or instead of) live production. The card notes this rather than hiding it.
- **A meter without a production reading** (your export is visible but no solar device reports production): the card falls back to an export-only view and never pretends to know your production. This applies on either power source — what decides it is whether a solar device reports production, not how your meter reading reaches PELS.

### Battery and inverter are read-only

PELS reads your solar production through Homey Energy — that is what makes capacity protection and the "Before solar:" split work — and your whole-home net power already reflects a battery charging or discharging. But PELS does **not** show a battery or inverter as a device, does not display a battery level, and does not command either. Auto-detected battery and solar devices are deliberately kept out of the device list and pickers, so you watch them in their own app, not in PELS.

If you also have a battery: because PELS only sees net power and cannot command storage, a battery charging from the grid uses the available power PELS would otherwise give your managed devices, and PELS cannot tell it to stop.

## What PELS does not do yet

- It does not drive your grid export to exactly zero. A device you have set to match your surplus is trimmed to it (in steps, and no faster than every couple of minutes), and the heating boost soaks up what it can — but PELS does not balance your whole home to zero export, and it does not command your inverter. In a **zero-export home** the heating boost can now recover throttled production opportunistically (see above) — but that works by adding useful load so the inverter produces more on its own, not by controlling the inverter.
- Solar money is shown for **today only** — a month-by-month "what my solar earned" history is a future direction.
- It does not charge a home battery from surplus, or control a battery or inverter — and battery control is not on the near-term roadmap.

## Export pricing

In some markets, exported solar is worth far less than the power you would otherwise buy — and in some it can cost you. In the Netherlands, the end of net metering (*salderingsregeling*) from 2027 means suppliers increasingly charge for exported power (*terugleverkosten*): exporting can actively cost money, so using your own solar becomes a direct saving rather than a smaller return.

PELS lets you tell it what exported power is worth to you. Under **Settings → Electricity prices**, turn on **"Use an export price"** (the section appears once PELS can see your solar — either a solar device reports production, or your meter has shown solar export) and enter what your power company pays you:

- **Share of spot price (%)** — how much of the hourly spot price (incl. VAT) you are paid per exported kWh. Available on the Norway price source, which has an hourly spot price; if your contract pays the raw spot price, enter 80.
- **Fixed amount** — added for every exported kWh, in the same unit as your other prices. It can be negative if you pay to export. On the Flow and Homey Energy price sources this fixed amount is the whole export price, since no hourly spot price is available there.

Once it is on:

- the **Budget tab** shows **"Export price now"** — the current hour's export price;
- scheduling uses it through the **planning price**: in hours where PELS expects your solar surplus to cover flexible load, it plans against what that energy is actually worth to you (the export price) rather than the import price — steering flexible load such as deadline EV charging into sunny hours.

Your money figures stay honest: receipts, usage costs, and the budget's money view remain on the import price you are billed, so they reconcile with your invoice.

## See also

- [Technical Reference — Solar Accounting](./technical.md#solar-accounting)
- [Daily Energy Budget](./daily-budget.md)
- [Cost-Saving Functions](./cost-saving-functions.md)
- [Configure an EV Charger](./ev-charger.md)
- [Smart Tasks](./smart-tasks.md)
