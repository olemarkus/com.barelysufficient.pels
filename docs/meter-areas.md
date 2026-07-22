---
title: Meter Areas (Multiple Meters)
description: Give a rental unit, annex, or cabin its own capacity limit by measuring it with its own meter — separate from the rest of your home.
---

# Meter Areas

Some homes have more than one electricity meter. A rental unit, an annex, or a
cabin often has its own meter and its own grid tariff step (effekttrinn).
**Meter areas** let PELS treat each of those parts of your home
as a separate capacity budget: it counts a part's devices against *that part's*
meter and keeps each one under its own limit — instead of lumping everything
together under one whole-home cap.

Everything not placed in a meter area belongs to the **Main home**, which keeps
working exactly as it always has.

## When you'd use this

Set up a meter area when a part of your home:

- Has its **own electricity meter** that Homey can read, and
- Has its **own capacity limit** you want to hold — most often its own grid
  tariff step, billed separately from the main house.

The classic case is a rental unit with a separate meter and a separate bill.
Without meter areas, a busy evening in the rental would eat into the main
house's available power (and the other way around). With a meter area, each
part stays under its own cap on its own terms.

**If your whole home is on a single meter, you don't need this.** One meter is
the Main home, and the [hourly hard cap](configuration.md) already covers it.

::: tip A meter area can be somewhere else entirely
The parts don't have to share a building. A cabin at another address works too,
as long as its devices are **cloud-connected** — Wi-Fi or cloud integrations,
controlled over the internet — so your Homey Pro can manage them from afar. Only
devices on a **local** radio (Zigbee, Z-Wave, Bluetooth, 433 MHz) need the Homey
physically nearby; a remote place with just those can't be reached. A cabin
whose devices are all cloud-connected can be run entirely remotely.
:::

## What you'll need

- **Homey Energy as your power source.** Meter areas rely on each meter
  reporting its own live power to Homey. This is the [Homey
  Energy](homey-energy.md) setup, not the Flow-driven power source — a Flow
  power reading has no meter identity, so PELS can't tell which area it belongs
  to.
- **A meter for the area, already added to Homey.** Each meter area is built
  around one power **meter** that Homey reads as that area's total — a HAN/P1
  meter reader or another sensor-class power meter. An ordinary metering smart
  plug or appliance won't appear in the picker: PELS only offers real
  whole-area meters, so it never mistakes one device's draw for the area's
  total. Add the meter to Homey first, then pick it here.
- **Your zones set up to match.** PELS assigns devices to a meter area by
  Homey **zone**: you point the area at the zone that part of your home lives
  in, and every device in that zone and its sub-zones counts toward that area.
  A tidy zone layout (for example, an "Apartment" zone with the rental's rooms
  under it) makes this a one-click choice.

## Setting up a meter area

Open **Settings → Multiple meters** and choose **Add meter area**. You fill in
three things:

| Field | What it is |
|---|---|
| **Meter** | The meter that measures this area's power use. PELS lists the whole-home and sensor-class power meters it found in Homey. |
| **Zone** | The zone this meter covers. Devices in this zone *and its sub-zones* count as part of the area. |
| **Name** | What you'll call it — "Rental", "Annex", "Cabin". |

As you pick a zone, PELS shows how many devices fall into the area ("*4 devices
in this zone and its sub-zones*") so you can check the sweep before you save.
It also pre-suggests a zone based on where the meter sits, and warns you if the
meter you picked sits *outside* the zone you chose — usually a sign the zone is
too narrow.

![The New meter area form in PELS: Meter set to the rental's meter, Zone set to the rental unit with a live "1 device in this zone and its sub-zones" count, and a Name field](/screenshots/meter-areas/editor.png)

When you save, the area appears in the list with its meter, zone, and device
count. Its devices are now **assigned to the area and measured against its
meter** right away. Actually *limiting* them is a separate, deliberate step —
a new area only simulates until you turn on control (see below), so nothing in
it is turned down the moment you save.

![The Multiple meters panel showing one meter area, "Rental unit", with its meter, zone and device count, a note that devices outside these areas belong to the Main home, and an Add meter area button](/screenshots/meter-areas/list.png)

::: tip The Main home is automatic
You never configure the Main home. It's simply everything that *isn't* in a
meter area. Add a rental as a meter area and the rest of the house stays the
Main home with no extra steps. Remove a meter area later and its devices move
straight back to the Main home.
:::

## Setting each area's limit

Each meter area gets its own limit under **Settings → Limits & safety**. At the
top of that page, the **"Set limits for"** switcher lets you pick the **Main
home** or any meter area, and the controls below apply to whichever you've
selected:

- **Hard cap (kW)** — that area's grid tariff step. PELS keeps each hour's
  average power under this, the same way it does for the whole home.
- **Safety margin (kW)** — the buffer below the cap where PELS starts easing
  off, so you approach the cap gently rather than bumping into it.

Below those, a readout shows where the safe pace starts each hour (the hard cap
minus the safety margin), so you can see the effect of your numbers before you
leave the page.

![PELS Limits & safety with "Rental unit" chosen in the "Set limits for" switcher: Hard cap 8 kW, Safety margin 0.3 kW, a readout that safe pace starts each hour at 7.7 kW, and the "Control devices in this area" switch off with a notice that PELS is only simulating this area](/screenshots/meter-areas/limits-simulation.png)

### Turn on control when you're ready

A new meter area starts in **simulation** — PELS watches and plans for it, but
does not yet turn anything down. A single switch, **"Control devices in this
area"**, is what makes it live:

- **Off** — PELS only *simulates* this area. Nothing in it is limited. This is
  how every area starts, so you can set the cap and watch how PELS *would*
  behave before it touches a device.
- **On** — PELS limits devices in this area to keep each hour under its cap,
  for real.

While an area is simulating, the page says so plainly and points you at the
switch. Flip it on once the cap looks right, and PELS begins holding that area
to its limit.

![The same Limits & safety panel with "Control devices in this area" turned on (green), and a "Status now" card reading Active — Power now 4.0 kW, Hard cap 8.0 kW, and "Limiting 1 device to stay under the cap"](/screenshots/meter-areas/limits-active.png)

::: tip Simulate first
Simulation is the safe way to trial a new area. Leave control off for a while
and watch the area's own status on its **Limits & safety** card — power now,
and what PELS *would* limit to hold the cap — then turn control on with
confidence. (The Usage tab is whole-home in this version and doesn't break out
per-area figures.)
:::

## Giving the Main home its own meter

If you've added meter areas but haven't told PELS which meter belongs to the
**Main home**, it falls back to reading the *combined* total of every meter —
and then the Main home's devices get limited to make room for the meter areas'
usage, which isn't what you want.

The fix is a one-time pick: set the Main home's own meter under **Settings →
Limits & safety → Whole-home meter**. PELS nudges you toward this whenever meter
areas exist without it. Once the Main home reads its own meter, each part —
Main home and every meter area — is measured and limited on its own.

## What meter areas cover — and what stays whole-home

Meter areas are, deliberately, about **capacity and safety per meter**. In this
version, each area gets its own:

- Hard cap and safety margin
- Real-time limiting and resume, on that area's own meter

Which devices give way first is decided by your existing **device priorities**.
Those are set once per operating mode and shared across the whole home — there
is no separate per-area priority list — but PELS applies them *within* each
area: when an area is busy, its own lower-priority devices give way first. A
device keeps the same priority wherever it lives.

These features apply to the **Main home only** in this version. A meter area's
devices get capacity control — cap and safety — and nothing else; they are
deliberately left out of the home-wide planning below:

- **Daily energy budget** and **price-based load shifting** — these run against
  the Main home. Devices in a meter area are **not** paced by the daily budget
  and are **not** moved into cheaper hours; only that area's cap and safety
  margin apply to them. So a rental's water heater, for example, is kept under
  the rental's cap but is not price-shifted in v1.
- **Smart tasks** (deadline charging and timed jobs) — not available for devices
  in a meter area yet. If you try to create or edit a smart task on a device
  that lives in a meter area, PELS declines it rather than running it. Smart
  tasks work on Main-home devices as usual.

Automations remain whole-home too: **Flow cards apply to PELS as a whole**, not
to a single meter area.

## Tips and troubleshooting

- **"Meter not found" / "Zone not found" on an area.** The meter device or zone
  it was built on no longer exists in Homey (renamed away, removed, or a device
  swapped out). Edit the area and re-pick the current meter or zone.
- **The apartment's devices aren't being limited.** Check that **"Control
  devices in this area"** is on for that area — a new area simulates until you
  turn control on. Also confirm your power source is **Homey Energy**.
- **PELS says it's reading the combined total.** Set the Main home's
  **Whole-home meter** (see above) so each part is measured on its own.
- **A device is in the wrong area.** Devices follow their Homey zone. Move the
  device to the right zone in Homey, or adjust the area's zone, and the device
  re-homes accordingly.

## See also

- [Configuration](configuration.md) — the hard cap and safety margin, explained
  for a single-meter home.
- [Using Homey Energy with PELS](homey-energy.md) — the power source meter areas
  build on.
- [How PELS decides](how-pels-decides.md) — what "limiting" and "safe pace"
  mean in practice.
