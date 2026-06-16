# PELS Persona Acquisition — the "before" angle

Companion to [`notes/personas.md`](personas.md). That note is the **after**
angle — the per-surface UX rubric for the *running* app, built on a
motivation/disposition spine (foundation: Safety + Trust; personas:
Set-and-forget owner / Orchestrator / Optimiser / Prosumer; scenarios:
Onboarding / Steady / Verifying / Failing).

This note is the **before**: who each persona is as a real Norwegian homeowner
*before they have ever heard of PELS*, the event that sends them searching, what
they type into Google, and where they ask for help. It is the **buyer/acquisition**
artifact (ends at install); `personas.md` is the **design/user** artifact (ends at
satisfaction). The two map **1:1 by persona**.

Why this matters to a contributor: the trigger, the search query, and the channel
they arrive through are what a new user has *just lived through* the moment they
first open a PELS surface. The onboarding hero, the first Smart-task receipt, and
the first failure page are all read against that backdrop.

**Scope of this file — durable demand side only.** This note holds the *stable*
half of the acquisition picture: triggers, the language people use, the queries
they search, the communities they gather in. The *volatile* half — the
competitive landscape they land in ("what they find"), which apps PELS is compared
against, and how it wins the final click — lives **outside git** as *generated
output* at
[`tmp/persona-discovery-landscape.md`](../tmp/persona-discovery-landscape.md)
(last generated 2026-06-15; regenerate via the recipe below).
When that file is missing (e.g. a fresh checkout), regenerate it with the tracked
recipe in [§ How to regenerate the snapshot](#how-to-regenerate-the-snapshot);
do not reconstruct the competitive detail inline here.

> **Sourcing caveat.** Researched 2026-06 from the Homey Community Forum,
> hjemmeautomasjon.no, Reddit / elbilforum.no, vendor support pages, and
> Norwegian news/explainers (sources at the end), refreshed 2026-06 with
> Norwegian + Dutch market research for the cost and prosumer cuts. Forum,
> Facebook, and price-comparison pages frequently 403 automated fetches, so some
> claims rest on search snippets rather than a full read. Treat specific kroner
> figures as illustrative — the durable finding is the *shape* of the demand and
> the language people use, not any one number. These feed **proto-persona
> hypotheses**, not validated research (see the evidence-tier note in
> `personas.md`).

> **Internal-positioning only.** This note names competitors and adjacent tools
> (Tibber, Easee, etc.) because the landscape people search through *is* the
> acquisition story — the sanctioned internal-notes exception to the
> no-competitor-names rule. **Never** surface any of these names in user-facing
> copy or in `packages/shared-domain/**` strings.

## The qualifying gate

Every PELS user has already outgrown the two things most Norwegian homes reach for
first: **Tibber-style smart charging** and their **charger's own built-in load
balancing**. Each owns exactly one axis — price *or* the fuse, one device. The
households those tools fully satisfy never become PELS users (in `personas.md`
terms, they are the **Negative persona**). PELS converts the home that has hit the
**seam** where one-axis tools fail: where capacity *and* price *and* several
devices *and* a deadline all have to be coordinated at once. Read every section
below as starting *after* that gate. (The detailed funnel of products people pass
through on the way to that realisation is the volatile part — see the `tmp/`
snapshot.)

**Acquisition is breach-driven.** Note that almost every trigger below is a
*breach or bill-shock* — a blown fuse, a tier jump, a cold shower, an uncharged
EV — which is the demand-side proof that **Safety/Reliability** is the universal
job (`personas.md` foundation). The personas differ not in *why* they first
search (almost always a breach) but in *how they shop for the fix*: delegate it,
build it, or verify it.

## Personas — the before angle

Each persona's *what they find* / *how they discover PELS* detail is in the `tmp/`
snapshot; here we keep the trigger, the language, the queries, the communities,
and the arrival channel. Sections map 1:1 to `personas.md`.

### 1. Set-and-forget owner — the "just-make-it-work" buyer *(Convenience)*

The Norwegian homeowner who has half-solved the problem and is tired of thinking
about it. Owns (or is buying) a Homey Pro, has a HAN/AMS meter, an EV charger and
a water heater, and has absorbed enough tariff literacy to be anxious — but has
**zero appetite for a project**. They want it done *for* them, "the way Tibber
does," and judge any solution by whether it lets them stop watching. The family
household lives here too: the fix must survive contact with a non-technical
partner and never produce a cold shower (the Wife/Spouse-Acceptance-Factor test).

- **Trigger.** A bill-or-breaker shock, not curiosity: either the monthly nettleie
  line jumped because they "snublet opp ett trinn" on the capacity tariff
  (reported up to ~4 500 kr/year, *bytt.no*), or the hovedsikring tripped
  mid-evening with the EV charging while the oven, dishwasher and floor heating ran
  together. The recurring "nettleiesjokk" news framing keeps it a durable worry.
- **How they phrase it.** "Hovedsikringen ryker hver gang jeg lader bilen og lager
  middag samtidig." / "Nettleia hoppet et trinn og jeg aner ikke hvilke timer som
  gjorde det — jeg vil bare at noe holder samlet effekt under grensa automatisk
  uten at jeg må følge med." They speak in absolute power ("hold samlet effekt
  under 10 kW") and convenience ("jeg vil ikke drive og passe på det selv") —
  **not** "capacity controller".
- **What they Google.** *anbefaling hjemmeautomasjon som styrer elbillader
  effekttariff som Tibber* · *hovedsikringen ryker når jeg lader elbil og lager
  middag samtidig* · *app som holder strømforbruket under en grense automatisk* ·
  *kapasitetsledd hvordan unngå tre-timers-regelen*.
- **Where they look.** hjemmeautomasjon.no forum + the "Hjemmeautomasjon" Facebook
  group (buyer-advice threads); the Homey Community Forum 🇳🇴 Norsk + Apps;
  ByggeBolig el-installasjon (entered via the blown-fuse panic); r/norge and
  r/elbil for tariff venting.
- **How they arrive.** Word-of-mouth inside the Norwegian Homey channel, not
  search — a "styring med Homey eller Tibber/Vibb?" or "maks kW samtidig
  belastning" thread that points them at the dedicated-app shelf. They are won on
  **"install, set the cap, walk away."**

### 2. Orchestrator — the frustrated Flow-builder *(Control)*

The technical Homey owner who *enjoys* the wiring but ran into the wall every forum
thread describes: the capacity-control Flow balloons into an unmaintainable state
machine — summed power into a Temporary-Variables tag, hysteresis so loads don't
flap, priority shedding, reconnection, and the **midnight-crossing price window the
standard cards can't handle**. They want the engine handed to them — but will still
pop every hood, own the priority order, and override by hand. *(Absorbs the old
"curious tinkerer" build-half and the build-my-first-Flow-card half of the old
"first-time user".)*

- **Trigger.** They watched their effektledd/kapasitetsledd tier creep up month
  over month and noticed it spikes "kun over 10kW når jeg lader Teslaen". Often a
  blown main fuse was the first jolt; the tariff realisation came second. Their
  instinct is to **build the rule themselves**, not buy a box.
- **How they phrase it.** "I want Homey to throttle the EV charger and shed the
  water heater when total draw approaches my limit, so I stop jumping a tier — and
  shift flexible load into the cheapest hours. I started building it as a Flow but
  it's *litt strevsomt å teste / vedlikeholde / endre*: summing the devices,
  stopping it flapping, prioritising what to drop first, and the price window that
  crosses midnight just breaks."
- **What they Google.** *flow for maks kW samtidig belastning effekttariff Homey* ·
  *Homey limit total power consumption flow prioritize devices* ·
  *community.homey.app effekttariff kapasitetsledd styre forbruk* · *styre
  varmtvannsbereder Nordpool Home Assistant automasjon*.
- **Where they look.** Homey Community Forum — Norsk + the canonical "maks kW
  samtidig belastning" and "prioritize units under max level" threads;
  hjemmeautomasjon.no (Strømsparing + Automasjoner); the **Home Assistant**
  Community "limit peak energy usage" / Norway-energy threads (the parallel DIY
  destination they weigh); the "Hjemmeautomasjon" Facebook group.
- **How they arrive.** Word-of-mouth in the Homey forum, after exhausting the DIY
  approach. They install PELS as a **hypothesis to test**, not a verdict to trust;
  the deciding hook is that it holds together the integrated behaviour their
  hand-built Flow kept dropping — whole-home shedding **with** budget **and** price
  **and** deadlines. Once verified for a week, they relax toward the Set-and-forget
  owner (the Control → Convenience maturity arc).

### 3. Optimiser — the burned single-axis veteran *(Cost, verification-first)*

The Tibber-and-Easee veteran who has outgrown single-device control. An EV
commuter (often Tesla/Easee/Zaptec) and/or hot-water-tank owner who already runs
smart charging and maybe a relay-controlled varmtvannsbereder, knows the
kapasitetsledd / effekttrinn vocabulary cold — and **has been personally burned**.
They don't need the problem explained; they need proof a tool does what it claims,
hour by hour and krone by krone, which is exactly why they distrust the next tool
too. *(Absorbs the old "skeptical optimiser" and the verify-your-own-setup half of
the old "curious tinkerer".)*

- **Trigger.** A concrete betrayal-by-tool event, in one of three canonical forms:
  (1) scheduled/smart charging silently failed — empty battery before the commute,
  or the car charged immediately at peak on plug-in instead of waiting for the
  cheap window; (2) a cold-shower surprise — the water-heater control left the tank
  empty for "siste mann i dusjen"; (3) the bill "snublet opp ett trinn" and they
  traced it to EV charging colliding with cooking. Each exposes a previously-trusted
  single-axis tool as handling price *or* fuse *or* one device — and failing at the
  seam.
- **How they phrase it.** "Jeg vil at bilen skal være ladet og klar til om
  morgenen på de billigste timene — uten at hovedsikringen ryker når jeg lader og
  lager mat samtidig, og uten å snuble opp ett effekttrinn. Tibber/laderen styrer
  bare bilen, ikke varmtvannsberederen og panelovnene samtidig. Og jeg vil faktisk
  kunne **SE** at den valgte de billige timene, og hva det kostet — ikke bare stole
  på at den gjorde det." The **verification demand** is the defining trait: they
  have been lied to by a schedule before.
- **What they Google.** *lade elbil klar til om morgenen billigste timer spotpris* ·
  *elbillader styre etter spotpris og effektgrense kapasitetsledd* · *Tibber
  effektbalansering holder ikke under grense* · *styre varmtvannsbereder etter
  strømpris unngå kald dusj* · *scheduled charging not starting EV charges
  immediately plugged in*.
- **Where they look.** Homey Community Forum — Norsk + Apps; hjemmeautomasjon.no +
  its Facebook group; **elbilforum.no** (Norsk elbilforening, the natural home for
  the EV-commuter cut); Home Assistant Community + `ev_smart_charging` GitHub
  issues; Tesla/MG owner forums for the "box-vs-car scheduling" regression;
  diskusjon.no / Futurehome forum for VVB scheduling.
- **How they arrive.** Word-of-mouth in the Homey forum, after hitting the
  flow-complexity wall or being burned by a single-axis tool. The deciding hook is
  **verifiability** the others lack — a per-hour schedule chart and a money figure
  they can audit *after* the run.

### 4. Prosumer — the solar self-consumer *(Autonomy — emerging)*

The solar-panel owner who wants to *self-consume* their own production instead of
exporting it for little money. **Emerging and not yet a Norwegian-mainstream
acquisition story** — included here as the demand the solar direction serves, and
because it is the dominant acquisition driver in the markets PELS is expanding to.

- **Trigger.** A collapse in the value of exported solar: in the **Netherlands**
  the salderingsregeling (net-metering) phase-out turns "my panels pay for
  themselves via the meter running backward" into "my export is suddenly worth a
  fraction" — the hard policy cliff that converts passive panel owners into active
  self-consumers (evidenced by a sharp home-battery surge). In NO/SE/DE the driver
  is softer (spot-price arbitrage on surplus, autarky as an identity). In all
  cases: "I'm giving my own energy away — how do I use it myself?"
- **How they phrase it.** "Hvordan bruke mest mulig av min egen solstrøm selv i
  stedet for å selge den billig?" / NL: "hoe verbruik ik mijn eigen zonnestroom na
  afschaffing saldering" / "stuur overschot naar de auto / boiler / warmtepomp".
- **What they Google.** *egenforbruk solceller maksimere uten batteri* ·
  *overskuddslading elbil solceller styring* · NL: *zelfverbruik zonnepanelen
  optimaliseren saldering afschaffing* · *overschot zonnestroom naar laadpaal /
  boiler sturen*.
- **Where they look.** NL: Tweakers (zonnepanelen / energie), r/solar, supplier
  knowledge bases (Frank, Zonneplan, Vandebron). NO/SE/DE: prosumer/plusskunde
  threads, Photovoltaikforum (DE, the deepest Eigenverbrauch/Autarkie culture),
  Home Assistant "PV excess / Überschussladen" projects.
- **How they arrive.** Today, rarely via the Norwegian capacity-tariff funnel — and
  PELS is currently **surplus-blind** (clamps net grid draw to ≥0), so it does not
  yet win this click. This persona is the acquisition case the solar work must
  unlock; until then, treat it as a forward-looking placeholder, not a live funnel.

## The failure-driven arrival (cross-cutting)

> **This is a scenario, not a 5th acquisition persona.** No `personas.md` persona
> corresponds to it; it is *how the four personas above arrive under failure*. The
> count stays four (one emerging Prosumer).

The old "recovering-from-mistake" and "notification-driven panic" personas were
not separate buyers — as acquisition stories they **overlap the Set-and-forget
owner and the Optimiser almost entirely** (same breach triggers, same forums).
What is distinct is the *arrival path under failure*, which matters for design:

- **Discovery-as-acquisition** — the breach itself is what sends them searching
  ("I want what Tibber does, but for the whole house against the effekttariff").
  This is already captured in each persona's *Trigger* above; the failure is the
  trigger.
- **Discovery-as-engagement-state** — they **already own and installed PELS**, and
  a Homey **notification deep-link** drops them straight into a PELS surface
  mid-incident. This is the **Failing scenario** in `personas.md`, not a new buyer.
  The acute (push, zero-patience, sentence-one diagnosis) vs recovering
  (self-navigating, aggregate postmortem) distinction is the load-bearing one — see
  the Failing-scenario rubric in `personas.md`.

The decisive hook for the failure-driven user — and the gap they could not find
elsewhere — is a tool that, *after* a failure, tells them **what changed, why, and
which single setting to adjust**, and renders that failure differently from a green
success. The acquisition wound that creates this user (a single-axis tool that
silently failed) is the same family of event PELS reproduces if its own failures
render as silently as a success.

**Trigger / language / query evidence** for the failure-driven arrival (kept here
because it is durable demand-side language):

- **How they phrase it.** "Jeg satte planlagt lading i går kveld og bilen ladet
  ikke i natt — nå må jeg på jobb." / "Berederen var skrudd av og siste mann i
  dusjen fikk iskaldt vann." / "min flow stoppet ikke berederen i tide" /
  "hvorfor lot den elbilen og komfyren gå samtidig?". They blame the **tool/setup**
  they trusted, not the concept.
- **What they Google.** *elbil ladet ikke om morgenen planlagt lading virket ikke* ·
  *Sparegris VVB styring kald dusj erfaring* · *homey flow stoppet ikke berederen i
  tide hysterese* · *snublet opp et trinn kapasitetsledd selv om jeg styrer
  forbruket* · *scheduled charging not starting EV charges immediately plugged in*.
- **Where they look.** Homey Community Forum — Norsk app threads with config-mistake
  reports; hjemmeautomasjon.no (VVB-styring, flow-maintenance pain); diskusjon.no
  (Energi/Smarthus cold-shower threads); elbilforum.no
  (scheduled-charging-didn't-fire); byggebolig.no (hovedsikring går); charger-vendor
  support (Easee "Lading starter ikke / stopper sporadisk") + Tesla/MG owner forums
  for the silent-schedule-failure class.

## How to regenerate the snapshot

The competitive landscape in `tmp/persona-discovery-landscape.md` is *generated
output* — this recipe is the tracked, reproducible path to rebuild it (the snapshot
file itself is intentionally git-ignored, so this section is where a fresh checkout
finds the instructions). Regenerate when competitor line-ups or capabilities have
moved (roughly quarterly, or before any positioning/marketing pass):

1. **Seed from the demand side above** — each persona's *What they Google* queries
   are the seed set.
2. **Run a discovery sweep** (WebSearch + WebFetch, or a fan-out workflow) over:
   - the **Homey App Store** energy category — refresh the whole-home app cluster
     (names + what each one claims);
   - **vendor capability pages** (Tibber effektbalansering / smartlading, the
     charger-balancer vendors, smart-boiler vendors) — confirm each is still
     single-axis and re-quote any "cannot guarantee" language;
   - **Home Assistant** components (`peaqev`, `ev_smart_charging`, the Norwegian
     cost-stack HACS components) for the DIY fork;
   - **nettleie explainers** for the manual-tips layer;
   - for the **Prosumer** cut: NL self-consumption / battery sources and the
     salderingsregeling phase-out timeline.
3. **Adversarially fact-check** capability claims — a competitor "can't do X" is
   the easiest thing to get wrong.
4. **Write the result** to `tmp/persona-discovery-landscape.md` with a fresh
   snapshot date. Keep competitive detail **out of git**; only this recipe is
   tracked.

## Sources — demand & trigger evidence

Verified 2026-06. **(403)** = blocks automated fetch (snippet-level). The
competitive-landscape / vendor-capability sources live with the `tmp/` snapshot,
not here.

**Capacity tariff, bill shock & the 24h-lag literacy**
- tu.no — *Ny nettleie: hvordan styre effektforbruket* —
  https://www.tu.no/artikler/ny-nettleie-hvordan-styre-effektforbruket/515299
- bytt.no — nettleie-sjokket / tre-timers-regelen (the ~4 500 kr/year figure)
  **(403)** —
  https://www.bytt.no/strom/strompriser/a-bbeb/nettleie-sjokket-slik-unngar-du-at-tre-timers-regelen-koster-deg-tusenlapper
- Nettavisen — *Nettleiesjokket er bare starten* —
  https://www.nettavisen.no/norsk-debatt/nettleiesjokket-er-bare-starten/o/5-95-3069641
- NAF — lading med ny nettleiemodell —
  https://www.naf.no/elbil/lading/slik-bor-du-lade-med-ny-nettleiemodell
- Zaptec — *ryker hovedsikringen når du lader elbilen og lager middag*
  (fuse-trip trigger) —
  https://zaptec.com/ryker-hovedsikringen-nar-du-lader-elbilen-og-lager-middag-samtidig/

**Homey Community Forum — what owners ask (search/demand evidence)**
- *Homey Tibber Easee — styre samlet effekt under 10kWh ved lading av elbil* —
  https://community.homey.app/t/homey-tibber-easee-hvordan-styre-samlet-effekt-under-10kwh-ved-lading-av-elbil/68540
- *Strømstyring med Homey eller Tibber/Vibb* —
  https://community.homey.app/t/stromstyring-med-homey-eller-tibber-vibb/139174
- *Fersk men frustrert ny bruker — sette opp styring ut fra pris* —
  https://community.homey.app/t/fersk-men-frustrert-ny-bruker-sette-opp-styring-ut-fra-pris/139448
- *Flow for maks kW samtidig belastning* —
  https://community.homey.app/t/flow-for-maks-kw-samtidig-belastning/54250
- *Flow to prioritize units under a max level* —
  https://community.homey.app/t/flow-to-prioritize-units-when-trying-to-keep-total-effect-under-a-max-level/139983
- *Sparegris VVB styring* (config-mistake reports) —
  https://community.homey.app/t/sparegris-vvb-styring/76998

**Other communities / Norwegian forums**
- hjemmeautomasjon.no — *anbefaling hjemmeautomasjon som styrer elbillader … på
  samme måte som Tibber* **(403)** —
  https://www.hjemmeautomasjon.no/forums/topic/11865-anbefaling-hjemmeautomasjon-som-styrer-elbillader-og-utstyr-opp-mot-effekttariff-p%C3%A5-samme-m%C3%A5te-som-tibber-gj%C3%B8r/
- diskusjon.no — *styre varmtvannsbereder* —
  https://www.diskusjon.no/topic/1915489-styre-varmtvannsbereder/
- byggebolig.no — *tidsstyring på varmtvannsbereder* —
  https://byggebolig.no/el-varmtvannsbereder/tidsstyring-pa-varmtvannsbereder
- byggebolig.no — *hovedsikring går — noen tips?* —
  https://www.byggebolig.no/elektro-belysning/hovedsikring-gar-noen-tips-eller-ma-jeg-leve-med-det

**EV scheduled-charging failure class (trigger evidence)**
- Tesla Club Sweden — scheduled charging didn't fire **(403)** —
  https://teslaclubsweden.se/forum/viewtopic.php?t=35403
- Tesla Motors Club — charges whenever plugged in regardless of schedule —
  https://teslamotorsclub.com/tmc/threads/charges-whenever-plugged-in-regardless-of-scheduled-charging-or-stopping-it.287545/
- MG EVs — scheduled charging "what am I doing wrong" —
  https://www.mgevs.com/threads/scheduled-charging-what-am-i-doing-wrong.14800/
- Home Assistant — `jonasbkarlsson/ev_smart_charging` issue #161 —
  https://github.com/jonasbkarlsson/ev_smart_charging/issues/161
- Easee — *Lading starter ikke / stopper sporadisk* **(403)** —
  https://support.easee.com/hc/no/articles/44493587474961-Lading-starter-ikke-stopper-sporadisk

**Prosumer / solar self-consumption (emerging — NL-led)**
- Rijksoverheid — salderingsregeling phase-out —
  https://www.rijksoverheid.nl/onderwerpen/energie-thuis/salderingsregeling
- Frank Energie — *afschaffing salderingsregeling* (self-consume framing) —
  https://www.frankenergie.nl/nl/kennisbank/zonnepanelen/afschaffing-salderingsregeling
- ioplus.nl — Dutch home-battery surge as solar export value collapses —
  https://ioplus.nl/en/posts/dutch-home-batteries-rise-as-solar-panel-additions-plummet
