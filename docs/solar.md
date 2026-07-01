---
title: Solar and Self-Consumption
description: Use more of your own rooftop solar with PELS — automatic capacity protection, a surplus heating boost, and honest accounting under export.
---

# Solar and Self-Consumption

If you have rooftop solar (PV), this page explains what PELS does with it today.

**Short version:** PELS uses your solar to protect your capacity for free, and it can nudge a heater to soak surplus instead of exporting it — while keeping your energy accounting honest. It does not yet drive your export to zero, show a self-consumption figure, or control a battery or inverter (see [What PELS does not do yet](#what-pels-does-not-do-yet)).

::: warning Requires the Homey Energy power source
The solar features below need the **Homey Energy** power source, with a solar device that reports production. On the Flow power source, PELS does not receive a solar signal.
:::

## What to do today

To use more of your own solar with PELS:

1. **Confirm your power source is Homey Energy** and your solar device's production shows up there. Capacity protection then works automatically — there is nothing else to turn on.
2. **Optionally turn on "Use solar surplus"** on a managed heating device (a water tank, floor heating, or a room heater) so surplus warms your home instead of going to the grid.
3. **Keep an EV charger managed with current control.** While the sun is up, a charging car naturally uses the freed-up power, so much of that charge comes from your own solar.

How much this helps depends on your home and the weather — it lowers your export modestly and automatically. A precise "use every watt" maximiser is a future direction, not a setting today.

## What PELS does with solar today

### Capacity protection just works

PELS watches your **net** grid power. When your panels cover part of the load, your net draw is lower, so there is more available power and PELS limits your managed devices less — exactly when the sun is out. This follows from how PELS measures power; there is nothing to turn on. See [Solar Accounting](./technical.md#solar-accounting).

In Norway, exported solar still earns roughly the spot price, so self-consumption is a modest gain — here the bigger win from panels is this automatic capacity protection. Where exported energy earns little, or costs you (see below), using your own solar matters much more.

### Use solar surplus to heat your home

On a managed heating device you can turn on **"Use solar surplus"** (the toggle appears once a solar device is present). When you are exporting enough to cover that device's own draw, PELS raises its target by the **"Solar-surplus boost"** amount (in °C, default +2), so the surplus warms your home or water instead of going to the grid. A small or short-lived export may not be enough to engage it.

![The "Use solar surplus" toggle in a managed device's detail page](/screenshots/device-detail/solar-surplus-toggle.png)
*Figure 1. Turn on "Use solar surplus" on a managed heating device.*

![The "Solar surplus" boost setting, raising the target by 2 °C while exporting](/screenshots/device-detail/solar-surplus-boost.png)
*Figure 2. "Solar-surplus boost" sets how much to lift the target while you are exporting.*

This boost:

- yields to your hard cap and daily budget — capacity protection always comes first, and the boost's energy counts toward your daily budget like any other use;
- works on any managed device with a temperature target (a water heater, floor heating, or a thermostat) that has a target set for the current mode;
- is a small, fixed step — once the room or tank reaches the raised target, the device stops drawing and any further surplus is exported.

PELS waits for the surplus to settle before engaging, and — to avoid flapping on passing clouds — it briefly holds the raised target for a few minutes after export stops before easing back. While the boost is engaged it takes precedence over any price-based lowering (your own solar is free); the rest of the time your normal price-based targets apply. It is a gentle "use a bit more of my own solar" nudge, not a precise export-to-zero controller.

### Big flexible loads use the freed-up power

Devices that run as hard as they can — such as an EV charger with current control — take up the room solar frees, up to your hard cap. So if a car is charging while the sun is up, much of that draw comes from your own solar rather than the grid.

PELS runs these loads to **available power up to your hard cap**, not matched to your surplus — so a large load can keep running (drawing from the grid) past the point the sun alone would cover, and charging after dark pulls entirely from the grid.

### Your accounting stays honest under export

When you export, PELS still uses net grid import for the **hard cap**, the **daily budget**, and your usage totals. An export hour is treated as zero energy used, so it never subtracts below zero or distorts your budget. Where your device meters show usage your panels covered locally, the managed/background split is labelled **"Before solar:"**. See [Daily Energy Budget](./daily-budget.md).

### Battery and inverter are read-only

PELS reads your solar production through Homey Energy — that is what makes capacity protection and the "Before solar:" split work — and your whole-home net power already reflects a battery charging or discharging. But PELS does **not** show a battery or inverter as a device, does not display a battery level, and does not command either. Auto-detected battery and solar devices are deliberately kept out of the device list and pickers, so you watch them in their own app, not in PELS.

If you also have a battery: because PELS only sees net power and cannot command storage, a battery charging from the grid uses the available power PELS would otherwise give your managed devices, and PELS cannot tell it to stop.

## What PELS does not do yet

- It does not drive your grid export to exactly zero — it uses surplus opportunistically (the heating boost, plus whatever your flexible loads want), but it does not trim a device moment to moment to match your surplus, and it cannot tell your inverter to produce less.
- It does not show a self-consumption rate, or split your usage into self-consumed versus exported kWh.
- It does not charge a home battery from surplus, or control a battery or inverter — and battery control is not on the near-term roadmap.

## Export pricing

In some markets, exported solar is worth far less than the power you would otherwise buy — and in some it can cost you. In the Netherlands, the end of net metering (*salderingsregeling*) from 2027 means suppliers increasingly charge for exported power (*terugleverkosten*): exporting can actively cost money, so using your own solar becomes a direct saving rather than a smaller return.

PELS lets you tell it what exported power is worth to you. Under **Settings → Electricity prices**, turn on **"Use an export price"** (the section appears once a solar device is present) and enter what your power company pays you:

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
