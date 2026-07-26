---
title: Meter Areas (Multiple Meters)
description: Give a rental unit, annex, or cabin its own capacity limit by measuring it with its own meter, separate from the rest of your home.
---

# Meter Areas

Some homes have more than one electricity meter. A rental unit, an annex, or a
cabin often has its own meter and its own grid tariff step (effekttrinn).
**Meter areas** let PELS treat each of those parts of your home as a separate
capacity budget: it counts a part's devices against *that part's* meter and
keeps each one under its own limit, instead of lumping everything together under
one whole-home cap.

Everything not placed in a meter area belongs to the **Main home**, which keeps
working exactly as it always has.

## When you'd use this

Set up a meter area when a part of your home:

- Has its **own electricity meter** that Homey can read, and
- Has its **own capacity limit** you want to hold, most often its own grid
  tariff step, billed separately from the main house.

The classic case is a rental unit with a separate meter and a separate bill.
Without meter areas, a busy evening in the rental would eat into the main
house's available power (and the other way around). With a meter area, each
part stays under its own cap on its own terms.

**If your whole home is on a single meter, you don't need this.** One meter is
the Main home, and the [hourly hard cap](configuration.md) already covers it.

::: tip A meter area can be somewhere else entirely
The parts don't have to share a building. A cabin at another address works too,
as long as its devices are **cloud-connected** (Wi-Fi or cloud integrations,
controlled over the internet), so your Homey Pro can manage them from afar. Only
devices on a **local** radio (Zigbee, Z-Wave, Bluetooth, 433 MHz) need the Homey
physically nearby, so a cabin whose devices are all cloud-connected can be run
entirely remotely.
:::

## What you'll need

- **Homey Energy as your power source.** Meter areas rely on each meter
  reporting its own live power to Homey. This is the [Homey
  Energy](homey-energy.md) setup, not the Flow-driven power source: a Flow power
  reading has no meter identity, so PELS can't tell which area it belongs to.
- **A meter for the area, already added to Homey.** Each meter area is built
  around one power **meter** that Homey reads as that area's total: a HAN/P1
  meter reader or another sensor-class power meter. An ordinary metering smart
  plug or appliance won't appear in the picker, because PELS only offers real
  whole-area meters, so it never mistakes one device's draw for the area's
  total. Add the meter to Homey first, then pick it here.
- **The Main home's own meter picked.** Before you can save your first meter
  area, select the Main home's **Whole-home meter** under **Settings → Limits &
  safety**. Without it PELS reads the combined total of every meter as the Main
  home's, and Main-home devices get limited by the area's usage. The
  [Giving the Main home its own meter](#giving-the-main-home-its-own-meter)
  section explains why. A few Homey setups read the whole home through an
  aggregate that doesn't report a device id — there the picker has nothing to
  offer, and meter areas aren't supported yet; PELS says so when you try to
  save one.
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
| **Name** | What you'll call it: "Rental", "Annex", "Cabin". |

As you pick a zone, PELS shows how many devices fall into the area ("*4 devices
in this zone and its sub-zones*") so you can check the sweep before you save.
It also pre-suggests a zone based on where the meter sits, and warns you if the
meter you picked sits *outside* the zone you chose, usually a sign the zone is
too narrow.

![The New meter area form in PELS: Meter set to the rental's meter, Zone set to the rental unit with a live "1 device in this zone and its sub-zones" count, and a Name field](/screenshots/meter-areas/editor.png)

When you save, the area appears in the list with its meter, zone, and device
count. Its devices are now **assigned to the area and measured against its
meter** right away. Actually *limiting* them is a separate, deliberate step: a
new area only simulates until you turn on control (see below), so nothing in it
is turned down the moment you save.

![The Multiple meters panel showing one meter area, "Rental unit", with its meter, zone and device count, a note that devices outside these areas belong to the Main home, and an Add meter area button](/screenshots/meter-areas/list.png)

::: tip The Main home is automatic
You never configure which devices belong to the Main home. It's simply
everything that *isn't* in a meter area. Add a rental as a meter area and the
rest of the house stays in the Main home automatically; remove the area later
and its devices move straight back.

There is one Main-home measurement step, and PELS asks for it before your first
area is saved: select the Main home's own **Whole-home meter** under **Settings
→ Limits & safety**. The section below explains why.
:::

## Setting each area's limit

Each meter area gets its own limit under **Settings → Limits & safety**. Once
you have at least one meter area, a **"Showing"** bar appears above that page.
Pick the **Main home** or any meter area there, and the cap and margin below
apply to whichever you've selected. The bar stays put as you scroll, so the
home you're editing is always named on screen:

- **Hard cap (kW):** that area's grid tariff step. PELS keeps each hour's
  average power under this, the same way it does for the whole home.
- **Safety margin (kW):** the buffer below the cap where PELS starts easing
  off, so you approach the cap gently rather than bumping into it.

Below those, a readout shows where the safe pace starts each hour (the hard cap
minus the safety margin), so you can see the effect of your numbers before you
leave the page.

![PELS Limits & safety with "Rental unit" as the shown home: Hard cap 8 kW, Safety margin 0.3 kW, a readout that safe pace starts each hour at 7.7 kW, and the "Control devices in this area" switch off with a notice that PELS is only simulating this area](/screenshots/meter-areas/limits-simulation.png)

### Turn on control when you're ready

A new meter area starts in **simulation**: PELS watches and plans for it, and
holds off on turning anything down. A single switch, **"Control devices in this
area"**, is what makes it live:

- **Off:** PELS only *simulates* this area. Nothing in it is limited. This is
  how every area starts, so you can set the cap and watch how PELS *would*
  behave before it touches a device.
- **On:** PELS limits devices in this area to keep each hour under its cap, for
  real.

While an area is simulating, the page says so plainly and points you at the
switch. Flip it on once the cap looks right, and PELS begins holding that area
to its limit.

![The same Limits & safety panel with "Control devices in this area" turned on (green), and a "Status now" card reading Active, with Power now 4.0 kW, Hard cap 8.0 kW, and "Limiting 1 device to stay under the cap"](/screenshots/meter-areas/limits-active.png)

::: tip Simulate first
Simulation is the safe way to trial a new area. Leave control off for a while
and watch the area's own status on its **Limits & safety** card (power now, and
what PELS *would* limit to hold the cap), then turn control on with confidence.
In this version the Usage tab shows whole-home figures.
:::

## Giving the Main home its own meter

If you've added meter areas but haven't told PELS which meter belongs to the
**Main home**, it has no way to know which of your meters to read for it. It
falls back to whichever whole-home reading your Homey offers first. That can
happen to be the Main home's own meter, in which case everything is measured
correctly. But nothing guarantees it, and the first reading can just as easily
land in one of two problem spots.

**A combined total that already includes a meter area.** PELS cannot detect
this one, so it keeps limiting the Main home against a figure that includes your
areas: Main-home devices get limited for usage that isn't theirs.

**A meter area's own meter.** When PELS can see that the reading belongs to one
of your meter areas, it stops limiting Main-home devices rather than act on a
meter that already has an owner. That is the safe choice for the area, but it is
the more serious of the two for you: nothing is keeping the Main home under its
hard cap until you pick its meter.

The fix is a one-time pick: set the Main home's own meter under **Settings →
Limits & safety → Whole-home meter**. Because the problem is silent, PELS treats
it as a requirement rather than a suggestion: saving a meter area asks for the
Whole-home meter first, and switching it back to *Automatic* while meter areas
are running is refused. Once the Main home reads its own meter, each part (the Main home and
every meter area) is measured and limited on its own.

## What a meter area governs

A meter area is about **capacity and safety for its own meter**. Each one has
its own hard cap and safety margin, and its own real-time limiting and resume on
that meter.

Which devices give way first follows your existing **device priorities**. You
set those once per operating mode and they apply across your whole home; inside
a busy meter area, its own lower-priority devices give way first, and a device
keeps the same priority wherever it lives.

Your **per-mode temperature settings** apply inside meter areas too. Where you
have set a target for the current mode, a heater or thermostat in an area is
held at it, and PELS writes its setpoint to get it there, the same way it does
for a Main-home device. That target is also what PELS puts the device back to
after lowering it to protect the area's cap, so a device with no target for the
current mode can stay at the lowered setpoint. Set one on the Modes screen for
every heater you want PELS to bring back. Change mode and the area's devices
follow within about half a minute; a change that would raise a device's
setpoint waits until PELS has a live reading from the area's meter, the same
rule as below.

Your whole-home features stay whole-home. The daily energy budget, price-based
load shifting, and smart tasks plan your Main-home devices, while each meter
area runs on its own cap, safety margin, and priorities. Smart tasks currently
run on Main-home devices, and PELS tells you if you set one on a device that
lives in a meter area.

Flow cards split three ways. Cards that act on a **device** work wherever that
device lives, including inside a meter area: turning power-limit control on or
off for it, budget exemptions, **Is device managed by PELS?**, expected power
usage, and the stepped-device reports. Cards about **modes, prices and the daily
budget** are settings for the whole app, so they behave exactly as they always
did. The cards that read or write a **capacity number** work from the Main home:
**Is there enough available power?**, **Is there available power for device?**
and **Set capacity limit**, even if the device you pick lives in a meter area.

One trigger is area-aware. **Hard cap breach imminent — manual action needed**
carries a `Home` tag naming the part of the home with no managed devices left to
limit, so a single Flow can tell you *where* to go and switch something off.

## Tips and troubleshooting

- **"Meter not found" / "Zone not found" on an area.** The meter device or zone
  it was built on no longer exists in Homey (renamed away, removed, or a device
  swapped out). Edit the area and re-pick the current meter or zone.
- **The apartment's devices aren't being limited.** Check that **"Control
  devices in this area"** is on for that area; a new area simulates until you
  turn control on. Also confirm your power source is **Homey Energy**.
- **PELS says it can't tell which meter it's reading for the Main home.** Set the
  Main home's **Whole-home meter** (see above) so each part is measured on its own.
- **Saving an area is refused over its name.** Each area needs a name of its own:
  not blank, not another area's name (spelling it differently in upper or lower
  case still counts), not "Main home" (that is what PELS calls everything outside
  your areas), and at most 40 characters. PELS says which of these applies.
- **"PELS handles up to 8 meter areas."** Eight is the limit. Remove an area you
  no longer meter separately to make room.
- **A device is in the wrong area.** Devices follow their Homey zone. Move the
  device to the right zone in Homey, or adjust the area's zone, and the device
  re-homes accordingly.
- **An area's heaters are stuck below their per-mode temperature.** First check
  that the heater has a target set for the current mode on the Modes screen. If
  it does, check that the area's meter device is online and reporting in Homey
  Energy: PELS does not raise a heater's setpoint in an area it has no live
  reading for, because that adds power draw it would not be able to see.
  Lowering a heater's setpoint still works, so a switch to a cooler mode always
  takes effect. Cooling-capable devices (air-conditioning, heat pumps,
  air-treatment units, and thermostats that may control one) are held in both
  directions while the meter is quiet, since cooling harder adds draw too.

## See also

- [Configuration](configuration.md): the hard cap and safety margin, explained
  for a single-meter home.
- [Using Homey Energy with PELS](homey-energy.md): the power source meter areas
  build on.
- [How PELS decides](how-pels-decides.md): what "limiting" and "safe pace" mean
  in practice.
