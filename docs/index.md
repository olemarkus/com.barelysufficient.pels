---
title: PELS
titleTemplate: false
description: Homey Pro app that keeps your power usage under control and moves heating to cheaper hours — automatically.
aside: false
outline: false
editLink: false
---

<section class="landing-hero">
  <div class="landing-panel landing-panel-primary">
    <p class="landing-kicker">For Homey Pro</p>
    <h1 class="landing-title">Intelligent, automatic power management for Homey Pro.</h1>
    <p class="landing-app-type">Homey app for Homey Pro</p>
    <p class="landing-lead">PELS watches your total power usage and automatically turns down heaters, water tanks, ventilation, or EV charging before you hit your hourly limit. When there is room again, it turns them back on — in the right order. It can also move heating to the cheapest hours of the day.</p>
    <div class="landing-actions">
      <a class="VPButton brand" href="https://homey.app/a/com.barelysufficient.pels">Get the app on the Homey App Store</a>
      <a class="VPButton alt" href="#is-pels-a-fit">See if PELS fits your home</a>
      <a class="VPButton alt" href="/getting-started.html">Open the user guide</a>
    </div>
  </div>
  <div class="landing-panel landing-panel-accent">
    <img class="landing-screenshot" src="/screenshots/landing-overview.png" alt="PELS overview showing live device states and power usage" />
  </div>
</section>

<div class="home-shell">
  <section class="landing-section" id="is-pels-a-fit">
    <p class="landing-section-kicker">Is it for you?</p>
    <h2 class="landing-section-title">PELS is worth it if any of this sounds familiar</h2>
    <p class="landing-section-text">You don't need a complicated setup to get value from PELS. If you have a few power-hungry devices and care about your electricity bill, that is usually enough.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>You have devices that use a lot of power</h3>
        <p>Heaters, floor heating, water heaters, ventilation, or EV charging are the most common ones. PELS works best when some of these can be turned down for a while without causing problems.</p>
      </article>
      <article class="landing-card">
        <h3>You want to stay within your capacity step</h3>
        <p>If you are on a grid tariff where going over your hourly limit bumps you to a more expensive step, PELS can keep you under the limit automatically.</p>
      </article>
      <article class="landing-card">
        <h3>You want heating to run when power is cheap</h3>
        <p>PELS can move heating to the cheapest hours of the day based on spot prices, so you spend less without having to check prices yourself.</p>
      </article>
    </div>
  </section>

  <section class="landing-section" id="how-pels-fits-into-homey">
    <p class="landing-section-kicker">Inside Homey</p>
    <h2 class="landing-section-title">Three things you use in practice</h2>
    <p class="landing-section-text">PELS lives entirely inside Homey. You configure it in the settings page, connect it with a few Flows, and check what it is doing in the overview.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card landing-card-with-screenshot">
        <img class="landing-card-screenshot" src="/screenshots/landing-devices.png" alt="PELS device list showing managed devices" />
        <h3>Device control</h3>
        <p>Pick the devices PELS can control, set your power limit, and choose how it should behave in different situations — like daytime vs. nighttime.</p>
        <a href="/configuration.html">Open configuration docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <img class="landing-card-screenshot" src="/screenshots/landing-usage.png" alt="PELS usage tab showing hourly energy chart" />
        <h3>Usage and insights</h3>
        <p>See how much power you are using, track hourly and daily totals, and understand your home's consumption patterns over time.</p>
        <a href="/insights-device.html">Open PELS Insights docs</a>
      </article>
      <article class="landing-card landing-card-with-screenshot">
        <img class="landing-card-screenshot" src="/screenshots/landing-price.png" alt="PELS price tab showing cheap and expensive hours" />
        <h3>Price optimization</h3>
        <p>PELS knows when electricity is cheap or expensive and shifts heating to save money — automatically, based on spot prices.</p>
        <a href="/flow-cards.html">See available Flow cards</a>
      </article>
    </div>
  </section>

  <section class="landing-section" id="quick-setup">
    <p class="landing-section-kicker">Get started</p>
    <h2 class="landing-section-title">A working setup takes about 15 minutes</h2>
    <p class="landing-section-text">Install the app, connect your power meter, set a limit, and pick the devices PELS should control. That is enough to get real value — you can fine-tune later.</p>
    <div class="landing-grid landing-grid-three">
      <article class="landing-card">
        <h3>Getting started</h3>
        <p>Install PELS from the Homey App Store, open the settings page, and create the Flow that sends your power meter reading to PELS.</p>
        <a href="/getting-started.html">Open getting started</a>
      </article>
      <article class="landing-card">
        <h3>Configuration</h3>
        <p>A full walkthrough of every tab in the settings page — devices, modes, budget, prices, and more.</p>
        <a href="/configuration.html">Open configuration docs</a>
      </article>
      <article class="landing-card">
        <h3>Going deeper</h3>
        <p>Set a daily energy budget, control EV charging step by step, or fine-tune how PELS distributes energy across the day.</p>
        <a href="/daily-budget.html">Open advanced guides</a>
      </article>
    </div>
    <p class="landing-note">Looking for the source code or want to contribute? See <a href="/contributor-setup.html">Contributor Setup</a> or <a href="https://github.com/olemarkus/com.barelysufficient.pels">GitHub</a>.</p>
  </section>
</div>
