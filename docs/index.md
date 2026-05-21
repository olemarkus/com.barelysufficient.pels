---
title: PELS
titleTemplate: false
description: Homey Pro app for power-limit control, EV charging, heating, hot water, ventilation, Smart tasks, and cheap-hour load shifting.
aside: false
outline: false
editLink: false
---

<section class="landing-hero">
  <div class="landing-panel landing-panel-primary">
    <p class="landing-kicker">For Homey Pro</p>
    <h1 class="landing-title">Intelligent, automatic power management for Homey Pro.</h1>
    <p class="landing-app-type">Homey app for Homey Pro</p>
    <p class="landing-lead">PELS watches your total power usage and automatically turns down heaters, water tanks, ventilation, or EV charging before you hit your hourly limit. When there is room again, it turns them back on in the right order. It can also plan Smart tasks and move flexible load to cheaper hours.</p>
    <div class="landing-actions">
      <a class="VPButton brand" href="https://homey.app/a/com.barelysufficient.pels">Get the app on the Homey App Store</a>
      <a class="VPButton alt" href="#is-pels-a-fit">See if PELS fits your home</a>
      <a class="VPButton alt" href="getting-started.html">Open the user guide</a>
    </div>
  </div>
  <div class="landing-panel landing-panel-accent">
    <figure class="landing-screenshot-frame">
      <img class="landing-screenshot" src="/screenshots/landing-overview.png" alt="PELS overview showing live device states and power usage" />
      <figcaption>The overview shows current whole-home power, the Safe pace now threshold, and which devices PELS is limiting or resuming.</figcaption>
    </figure>
  </div>
</section>

<div class="home-shell">
  <section class="landing-section" id="is-pels-a-fit">
    <p class="landing-section-kicker">Is it for you?</p>
    <h2 class="landing-section-title">PELS is worth it if any of this sounds familiar</h2>
    <p class="landing-section-text">You don't need a complicated setup to get value from PELS. If you have a few power-hungry devices and care about your electricity bill, that is usually enough. Norwegian users can also read the <a href="stromstyring-norge.html">Norwegian overview for strømstyring, kapasitetsledd, and elbillading</a>.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>You have devices that use a lot of power</h3>
        <p>Heaters, floor heating, water heaters, ventilation, or EV charging are the most common ones. PELS works best when some of these can be turned down for a while without causing problems. For chargers, start with <a href="use-cases/homey-ev-charging-power-limit.html">Homey EV charging without crossing your power limit</a>.</p>
      </article>
      <article class="landing-card">
        <h3>You want to stay within your hourly limit</h3>
        <p>If you are on a power-based grid tariff (effekttrinn in Norway, and similar power-tariff models in Sweden and Finland) where consumption above a chosen level costs more, PELS can keep your hourly draw under the limit automatically.</p>
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

  If your charger is paired in Homey, PELS can calculate the charging current while still protecting the house limit. Your Flow maps the PELS current value to the charger app.

  [Read the EV charging use case](./use-cases/homey-ev-charging-power-limit.md) · [Configure an EV charger](./ev-charger.md) · [Zaptec example](./zaptec-ev-charger.md)

  ### Move hot water, heating or ventilation toward cheap hours

  If a water heater, floor heating, panel heater or ventilation unit can run earlier or later, use price shifting, Smart tasks or Flow-booked cheap hours. The hard cap still takes priority.

  [Read the hot water and heating use case](./use-cases/homey-water-heater-cheap-hours.md) · [Compare cost-saving functions](./cost-saving-functions.md) · [Smart Tasks](./smart-tasks.md) · [Book cheap hours with Flows](./how-to-book-cheap-hours-with-flows.md)

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
          <img class="landing-card-screenshot" src="/screenshots/landing-devices.png" alt="PELS device list showing managed devices" />
          <figcaption>The device list is where you choose which devices are managed, can be limited to stay under the hard cap, or adjusted by price.</figcaption>
        </figure>
        <h3>Device control</h3>
        <p>Pick the devices PELS can control, set your hard cap, and choose how it should behave in different situations — like daytime vs. nighttime.</p>
        <a href="configuration.html">Open configuration docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" src="/screenshots/landing-usage.png" alt="PELS usage tab showing hourly energy chart" />
          <figcaption>Usage shows hourly and daily energy history so you can see how the home behaves over time.</figcaption>
        </figure>
        <h3>Usage and insights</h3>
        <p>See how much power you are using, track hourly and daily totals, and understand your home's consumption patterns over time.</p>
        <a href="insights-device.html">Open PELS Insights docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <figure class="landing-card-media">
          <img class="landing-card-screenshot" src="/screenshots/landing-price.png" alt="PELS price tab showing cheap and expensive hours" />
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
        <p>Install PELS from the Homey App Store, open the settings page, and create the Flow that sends your power meter reading to PELS.</p>
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
    <p class="landing-note">Looking for the source code or want to contribute? See <a href="contributor-setup.html">Contributor Setup</a> or <a href="https://github.com/olemarkus/com.barelysufficient.pels">GitHub</a>.</p>
  </section>
</div>
