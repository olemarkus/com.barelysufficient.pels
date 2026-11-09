---
title: "PELS for Homey Pro: capacity limits, EV charging, cheap hours"
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
      <a class="VPButton alt" href="#start-by-problem">See if PELS fits your home</a>
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
  <section class="landing-section" id="a-day-with-pels">
    <p class="landing-section-kicker">In practice</p>
    <h2 class="landing-section-title">A day with PELS on Homey Pro</h2>
    <p class="landing-section-text">What PELS does for a home over one day, shown in its own screens and Homey widgets from a demo home.</p>
    <div class="landing-grid landing-grid-two">
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" loading="lazy" src="/screenshots/widgets/held-back-1-list.png" alt="Held-back devices widget: hot water, car charger and bathroom floor each held back for a few minutes, with a Let it run now button" />
        </figure>
        <h3>Evening: the peak stays under your limit</h3>
        <p>Cooking, showers and the car all want power at once. PELS holds back the lowest-priority devices for a few minutes and brings each one back as soon as there is room. The Held-back devices widget shows who is waiting, and Let it run now overrides any of them.</p>
        <a href="widgets.html">See the Homey widgets</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" loading="lazy" src="/screenshots/widgets/smart-tasks-ended.png" alt="Ended Smart task for an EV charger: charged from 45 to 80 percent, target reached at 06:00 for a 06:30 deadline" />
        </figure>
        <h3>Night: the car is ready by morning</h3>
        <p>Ask for 80 % by 06:30. PELS charges in the cheapest hours that still get there, stays inside your limit while it does, and shows how it went when the task ends.</p>
        <a href="smart-tasks.html">Smart tasks</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" loading="lazy" src="/screenshots/landing-cheap-hours.png" alt="Smart task plan for a water heater: on track, needs 11.1 kWh at an estimated cost, with a price chart of the scheduled hours before the deadline" />
        </figure>
        <h3>Hot water heats when power is cheap</h3>
        <p>Give the water heater a temperature and a deadline. PELS picks the cheapest hours that still reach it, shows the energy needed and the estimated cost, and tracks progress until it is done.</p>
        <a href="use-cases/homey-water-heater-cheap-hours.html">Hot water and heating in cheaper hours</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" loading="lazy" src="/screenshots/landing-usage.png" alt="PELS Usage tab showing today's grid energy and the Solar card with production, use at home and export by day" />
        </figure>
        <h3>Daytime: your solar stays at home</h3>
        <p>Surplus solar goes to hot water, heating, the car or a home battery instead of the grid. Usage shows what your panels produced and how much of it your home used.</p>
        <a href="use-cases/homey-solar-home-battery.html">Solar and home battery</a>
      </article>
    </div>
  </section>

  <section class="landing-section">

  <p class="landing-section-kicker">Is it for you?</p>

  ## Use cases: capacity tariffs, EV charging, cheap hours and solar {#start-by-problem .landing-section-title}

  PELS fits any home with a Homey Pro, a whole-home power meter and a few devices that use a lot of power, such as heaters, water heaters, ventilation or an EV charger. Pick the problem closest to yours. Start with the use-case page when one exists, then continue into the setup guide.
  {.landing-section-text}

  ### Stay below a capacity tariff or power limit

  A capacity tariff, known in various countries as <span lang="nb">kapasitetsledd</span>, <span lang="nl">capaciteitstarief</span>, <span lang="sv">effektavgift</span> or <span lang="fi">tehomaksu</span>, charges for your highest hourly or quarter-hour power. If you have one, or just want the house to stay under a set level, start with power limiting. PELS watches whole-home power and turns down lower-priority devices before you cross the limit, on an hourly or a 15-minute average.

  [<span lang="nb">Strømstyring og kapasitetsledd på norsk</span>](./stromstyring-norge.md) · [Compare cost-saving functions](./cost-saving-functions.md) · [Open configuration docs](./configuration.md)

  ### Smart EV charging within your power limit

  If your charger is paired in Homey, PELS calculates the charging current while still protecting the house limit. Some chargers, such as Easee, take that current directly; for others a Flow passes it to the charger app. If the real goal is a battery target by morning, use deadline charging with state of charge.

  [Read the EV charging use case](./use-cases/homey-ev-charging-power-limit.md) · [Deadline Charging With State of Charge](./how-to-deadline-charging-soc.md) · [Configure an EV charger](./ev-charger.md) · [Easee](./easee-ev-charger.md) · [Zaptec](./zaptec-ev-charger.md)

  ### Run hot water, heating and ventilation in the cheapest hours

  With a dynamic electricity contract, known in various countries as <span lang="nl">dynamisch energiecontract</span>, <span lang="de">dynamischer Stromtarif</span> or <span lang="nb">spotpris</span>, a water heater, heat pump, floor heating, panel heater or ventilation unit can run when power is cheapest. Use price shifting, Smart tasks or Flow-booked cheap hours. The hard cap still takes priority.

  [Read the hot water and heating use case](./use-cases/homey-water-heater-cheap-hours.md) · [Compare cost-saving functions](./cost-saving-functions.md) · [Smart Tasks](./smart-tasks.md) · [Book cheap hours with Flows](./how-to-book-cheap-hours-with-flows.md)

  ### Use more of your own solar with a home battery

  With solar panels, PELS puts your surplus to work in hot water, heating or the car, even behind an inverter limited to zero export, and the Usage tab shows what your panels produced and what that saved you. A home battery joins your priority list: your sun goes to devices and the battery in your order, and when the house nears its limit the battery discharges on its turn, by default before anything is turned down.

  [Read the solar and home battery use case](./use-cases/homey-solar-home-battery.md) · [Solar and Self-Consumption](./solar.md) · [Solar accounting](./technical.md#solar-accounting)

  ### Use Home, Away and Night for different energy behavior

  If your home should behave differently when you are home, away or asleep, configure modes and switch them from Homey Flows. Modes can change comfort targets and priorities without rebuilding your automations.

  [Read the modes use case](./use-cases/homey-home-away-night-energy-modes.md) · [Temporarily change one heater's temperature](./use-cases/homey-temporary-heater-temperature.md) · [Open configuration docs](./configuration.md) · [See available Flow cards](./flow-cards.md)

  ### Use Homey Energy, Tibber Pulse, an AMS/HAN or P1 meter reader, or Flow data as input

  PELS needs whole-home power and, for price features, a price source. Homey Energy can provide both in many setups; Flow data can be used when you already have another meter or price source.

  [Using Homey Energy](./homey-energy.md) · [Getting Started](./getting-started.md) · [Price tags in Flow & HomeyScript](./price-tags.md)

  </section>


  <section class="landing-section" id="quick-setup">
    <p class="landing-section-kicker">Get started</p>
    <h2 class="landing-section-title">Start with a basic setup in about 15 minutes</h2>
    <p class="landing-section-text">Install the app, connect your power meter, set a limit, and pick one or two devices PELS should control. That is enough to start learning how it behaves. You can add EV charging, modes, Daily Energy Budget and Smart Tasks later.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>Getting started</h3>
        <p>Install PELS from the Homey App Store, open its settings under More &gt; Apps &gt; PELS, and follow the Set up PELS card: your power meter first, then the devices PELS manages.</p>
        <a href="getting-started.html">Open getting started</a>
      </article>
      <article class="landing-card">
        <h3>Configuration</h3>
        <p>A full walkthrough of every tab in the settings page: devices, modes, budget, prices, and more.</p>
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
