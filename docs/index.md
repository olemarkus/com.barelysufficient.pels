---
title: "PELS — Power-limit control & cheap-hour load shifting for Homey Pro"
titleTemplate: false
description: PELS keeps your Homey Pro home under its power limit, shifts EV charging, heating, and hot water into the cheapest hours, and puts your solar and home battery to work.
aside: false
outline: false
editLink: false
---

<section class="landing-hero">
  <div class="landing-panel landing-panel-primary">
    <p class="landing-kicker">For Homey Pro</p>
    <h1 class="landing-title">Intelligent, automatic power management for Homey Pro.</h1>
    <p class="landing-app-type">Homey app for Homey Pro</p>
    <p class="landing-lead">PELS watches your total power usage and turns down heaters, water tanks, ventilation, and EV charging before you hit your capacity limit. The moment there is room again, it brings them back in priority order. It plans Smart tasks around deadlines and shifts flexible load into the cheapest hours of the day, automatically, every hour, without you watching the meter. With solar panels or a home battery, PELS sends your surplus to useful load and uses the battery to hold your limit at its place in your priority order, by default before it turns anything down.</p>
    <div class="landing-actions">
      <a class="VPButton brand" href="https://homey.app/a/com.barelysufficient.pels">Get the app on the Homey App Store</a>
      <a class="VPButton alt" href="#is-pels-a-fit">See if PELS fits your home</a>
      <a class="VPButton alt" href="getting-started.html">Open the user guide</a>
    </div>
    <p class="landing-inline-note"><strong>Already installed?</strong> Open the Homey app and go to More &gt; Apps &gt; PELS &gt; Settings. The Set up PELS card there shows what to do first.</p>
  </div>
  <div class="landing-panel landing-panel-accent">
    <figure class="landing-screenshot-frame">
      <img class="landing-screenshot" src="/screenshots/landing-overview.png" alt="PELS Overview tab showing whole-home power now, the Safe pace now marker, live solar production, and a home battery supplying 2.4 kW to hold the limit" />
      <figcaption>The overview shows current whole-home power, the Safe pace now marker, your solar right now, and what PELS is doing to hold your limit.</figcaption>
    </figure>
  </div>
</section>

<div class="home-shell">
  <section class="landing-section" id="is-pels-a-fit">
    <p class="landing-section-kicker">Is it for you?</p>
    <h2 class="landing-section-title">PELS is worth it if any of this sounds familiar</h2>
    <p class="landing-section-text">You don't need a complicated setup to get value from PELS. A few power-hungry devices and an interest in your electricity bill are all it takes. Norwegian users can also read the <a href="stromstyring-norge.html">Norwegian overview for strømstyring, kapasitetsledd, and elbillading</a>.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>You have devices that use a lot of power</h3>
        <p>Heaters, floor heating, water heaters, ventilation, and EV charging are the obvious wins. PELS turns them down when capacity gets tight and brings them back when there is room — comfort stays steady, the bill drops. For chargers, start with <a href="use-cases/homey-ev-charging-power-limit.html">Homey EV charging without crossing your power limit</a>.</p>
      </article>
      <article class="landing-card">
        <h3>You want to stay within your capacity limit</h3>
        <p>If you are on a power-based grid tariff (effekttrinn in Norway, similar power-tariff models in Sweden and Finland, or the quarter-hour capacity tariff in Flanders) where consumption above a chosen level costs more, PELS keeps your hourly or quarter-hour draw under the limit automatically.</p>
      </article>
      <article class="landing-card">
        <h3>You want flexible load to run when power is cheap</h3>
        <p>PELS can move heating, charging, and task-based load toward cheaper hours, so you spend less without having to check prices yourself. This works anywhere with dynamic hourly electricity prices — see <a href="homey-energy.html">Using Homey Energy</a> if you are outside Norway.</p>
      </article>
    </div>
  </section>

  <section class="landing-section">

  ## Start by problem {.landing-section-title}

  Pick the problem that sounds closest to what you are trying to solve. Start with the use-case page when one exists, then continue into the setup guide.
  {.landing-section-text}

  ### Stay below a capacity tariff step or power limit

  If your grid tariff gets more expensive above a chosen hourly level, start with power limiting. PELS watches whole-home power and limits lower-priority devices before the hard cap is crossed.

  [Compare cost-saving functions](./cost-saving-functions.md) · [Open configuration docs](./configuration.md)

  ### Charge an EV without crossing your whole-home power limit

  If your charger is paired in Homey, PELS calculates the charging current while still protecting the house limit. Some chargers, such as Easee, take that current directly; for others a Flow passes it to the charger app. If the real goal is a battery target by morning, use deadline charging with state of charge.

  [Read the EV charging use case](./use-cases/homey-ev-charging-power-limit.md) · [Deadline Charging With State of Charge](./how-to-deadline-charging-soc.md) · [Configure an EV charger](./ev-charger.md) · [Easee](./easee-ev-charger.md) · [Zaptec](./zaptec-ev-charger.md)

  ### Move hot water, heating or ventilation toward cheap hours

  If a water heater, floor heating, panel heater or ventilation unit can run earlier or later, use price shifting, Smart tasks or Flow-booked cheap hours. The hard cap still takes priority.

  [Read the hot water and heating use case](./use-cases/homey-water-heater-cheap-hours.md) · [Compare cost-saving functions](./cost-saving-functions.md) · [Smart Tasks](./smart-tasks.md) · [Book cheap hours with Flows](./how-to-book-cheap-hours-with-flows.md)

  ### Use more of your own solar

  With solar panels, PELS puts your surplus to work in hot water, heating or the car, even behind an inverter limited to zero export, and the Usage tab shows what your panels produced and what that saved you. A home battery joins your priority list: your sun goes to devices and the battery in your order, and when the house nears its limit the battery discharges on its turn, by default before anything is turned down.

  [Read the solar and home battery use case](./use-cases/homey-solar-home-battery.md) · [Solar and Self-Consumption](./solar.md) · [Solar accounting](./technical.md#solar-accounting)

  ### Use Home, Away and Night for different energy behavior

  If your home should behave differently when you are home, away or asleep, configure modes and switch them from Homey Flows. Modes can change comfort targets and priorities without rebuilding your automations.

  [Read the modes use case](./use-cases/homey-home-away-night-energy-modes.md) · [Open configuration docs](./configuration.md) · [See available Flow cards](./flow-cards.md)

  ### Use Homey Energy, Tibber Pulse, AMS/HAN/P1 or Flow data as input

  PELS needs whole-home power and, for price features, a price source. Homey Energy can provide both in many setups; Flow data can be used when you already have another meter or price source.

  [Using Homey Energy](./homey-energy.md) · [Getting Started](./getting-started.md) · [Price tags in Flow & HomeyScript](./price-tags.md)

  </section>

  <section class="landing-section" id="how-pels-fits-into-homey">
    <p class="landing-section-kicker">Inside Homey</p>
    <h2 class="landing-section-title">Four things you use in practice</h2>
    <p class="landing-section-text">PELS lives entirely inside Homey. You configure it in the settings page, connect it with a few Flows, add Smart tasks when something must be ready, and check what it is doing in the overview.</p>
    <div class="landing-grid landing-grid-two">
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" src="/screenshots/landing-devices.png" alt="PELS Devices page listing managed heaters, a water heater, and an EV charger with Managed, Limit, and Price toggles" />
          <figcaption>The device list is where you choose which devices are managed, can be limited to stay under the hard cap, or adjusted by price.</figcaption>
        </figure>
        <h3>Device control</h3>
        <p>Pick the devices PELS can control, set your hard cap, and choose how it should behave in different situations — like daytime vs. nighttime.</p>
        <a href="configuration.html">Open configuration docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" src="/screenshots/landing-usage.png" alt="PELS Usage tab showing today's grid energy, the solar the home used itself, and the Solar card with production, use at home and export by day" />
          <figcaption>Usage shows your energy history and what your solar did: produced, used at home and exported.</figcaption>
        </figure>
        <h3>Usage and insights</h3>
        <p>See how much power you are using, track hourly and daily totals, and see how much of your own solar your home used instead of sending it to the grid.</p>
        <a href="insights-device.html">Open PELS Insights docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" src="/screenshots/landing-price.png" alt="PELS price view showing the current price source and the cheap and expensive hours used to shift flexible load" />
          <figcaption>Price settings show the current price source and the cheap/expensive hours PELS can use to choose when flexible devices should run.</figcaption>
        </figure>
        <h3>Price optimization</h3>
        <p>PELS knows when electricity is cheap or expensive and shifts flexible load to save money automatically, based on spot prices.</p>
        <a href="flow-cards.html">See available Flow cards</a>
      </article>
      <article class="landing-card">
        <h3>Smart tasks</h3>
        <p>Tell PELS that a charger, room, or water heater should be ready by a specific time, and it plans useful hours before the ready-by time.</p>
        <a href="smart-tasks.html">Open Smart tasks docs</a>
      </article>
    </div>
  </section>

  <section class="landing-section" id="quick-setup">
    <p class="landing-section-kicker">Get started</p>
    <h2 class="landing-section-title">Start with a basic setup in about 15 minutes</h2>
    <p class="landing-section-text">Install the app, connect your power meter, set a limit, and pick one or two devices PELS should control. That is enough to start learning how it behaves — you can add EV charging, modes, Daily Energy Budget and Smart Tasks later.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>Getting started</h3>
        <p>Install PELS from the Homey App Store, open its settings under More &gt; Apps &gt; PELS, and follow the Set up PELS card: your power meter first, then the devices PELS manages.</p>
        <a href="getting-started.html">Open getting started</a>
      </article>
      <article class="landing-card">
        <h3>Configuration</h3>
        <p>A full walkthrough of every tab in the settings page — devices, modes, budget, prices, and more.</p>
        <a href="configuration.html">Open configuration docs</a>
      </article>
      <article class="landing-card">
        <h3>Going deeper</h3>
        <p>Compare the cost-saving functions, set a daily energy budget, book cheap hours with Flows, or fine-tune EV charging.</p>
        <a href="cost-saving-functions.html">Compare cost-saving functions</a>
      </article>
    </div>
    <p class="landing-note">New to PELS? <a href="how-pels-decides.html">How PELS decides</a> explains it in plain language, the <a href="glossary.html">Glossary</a> defines every term, and <a href="troubleshooting.html">Troubleshooting</a> fixes the common snags.</p>
    <p class="landing-note">Looking for the source code or want to contribute? See <a href="contributor-setup.html">Contributor Setup</a> or <a href="https://github.com/olemarkus/com.barelysufficient.pels">GitHub</a>.</p>
  </section>
</div>
