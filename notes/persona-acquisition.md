# PELS Persona Acquisition — the "before" angle

Companion to [`notes/personas.md`](personas.md). That note describes six
**engagement-state** personas — how someone uses the *running* app. This
note describes the **before**: who each persona is as a real Norwegian
homeowner *before they have ever heard of PELS*, the event that sends
them searching, what they type into Google, and where they ask for help.

Why this matters to a contributor: the trigger, the search query, and the
channel they arrive through are what a new user has *just lived through*
the moment they first open a PELS surface. The onboarding hero, the first
Smart-task receipt, and the first failure page are all read against that
backdrop.

**Scope of this file — durable demand side only.** This note deliberately
holds the *stable* half of the acquisition picture: triggers, the
language people use, the queries they search, and the communities they
gather in. Those change slowly and are worth versioning. The *volatile*
half — the competitive landscape they land in ("what they find"), which
apps PELS is compared against, and how it wins the final click — is a
snapshot that rots within months and whose git history is worthless. It
lives **outside git**, as *generated output*, at
[`tmp/persona-discovery-landscape.md`](../tmp/persona-discovery-landscape.md).
When that file is missing (e.g. a fresh checkout), regenerate it with the
tracked recipe in [§ How to regenerate the snapshot](#how-to-regenerate-the-snapshot)
below; do not reconstruct the competitive detail inline here.

> **Sourcing caveat.** Researched 2026-06 from the Homey Community Forum,
> hjemmeautomasjon.no, Reddit / elbilforum.no, vendor support pages, and
> Norwegian news/explainers (sources at the end). Forum, Facebook, and
> price-comparison pages frequently 403 automated fetches, so some claims
> rest on search snippets rather than a full read. Treat specific kroner
> figures as illustrative — the durable finding is the *shape* of the
> demand and the language people use, not any one number.

> **Internal-positioning only.** This note names competitors and adjacent
> tools (Tibber, Easee, etc.) because the landscape people search through
> *is* the acquisition story — the sanctioned internal-notes exception to
> the no-competitor-names rule. **Never** surface any of these names in
> user-facing copy or in `packages/shared-domain/**` strings.

## The qualifying gate

Every PELS user has already outgrown the two things most Norwegian homes
reach for first: **Tibber-style smart charging** and their **charger's
own built-in load balancing**. Each owns exactly one axis — price *or*
the fuse, one device. The households those tools fully satisfy never
become PELS users. PELS converts the home that has hit the **seam** where
one-axis tools fail: where capacity *and* price *and* several devices
*and* a deadline all have to be coordinated at once. Read every section
below as starting *after* that gate. (The detailed funnel of products
people pass through on the way to that realisation is the volatile part —
see the `tmp/` snapshot.)

## Personas — the before angle

Each persona's *what they find* / *how they discover PELS* detail is in
the `tmp/` snapshot; here we keep the trigger, the language, the queries,
the communities, and the arrival channel.

### 1. Set-and-forget owner: the "just-make-it-work" buyer

The Norwegian homeowner who has half-solved the problem and is tired of
thinking about it. Owns (or is buying) a Homey Pro, has a HAN/AMS meter,
an EV charger and a water heater, and has absorbed enough tariff literacy
to be anxious — but has **zero appetite for a project**. They want it
done *for* them, "the way Tibber does," and judge any solution by whether
it lets them stop watching.

- **Trigger.** A bill-or-breaker shock, not curiosity: either the monthly
  nettleie line jumped because they "snublet opp ett trinn" on the
  capacity tariff (reported up to ~4 500 kr/year, *bytt.no*), or the
  hovedsikring tripped mid-evening with the EV charging while the oven,
  dishwasher and floor heating ran together. The recurring "nettleiesjokk"
  news framing keeps it a durable worry, not a one-off.
- **How they phrase it.** "Hovedsikringen ryker hver gang jeg lader bilen
  og lager middag samtidig." / "Nettleia hoppet et trinn og jeg aner ikke
  hvilke timer som gjorde det — jeg vil bare at noe holder samlet effekt
  under grensa automatisk uten at jeg må følge med." They speak in
  absolute power ("hold samlet effekt under 10 kW") and convenience ("jeg
  vil ikke drive og passe på det selv") — **not** "capacity controller".
- **What they Google.** *anbefaling hjemmeautomasjon som styrer elbillader
  effekttariff som Tibber* · *hovedsikringen ryker når jeg lader elbil og
  lager middag samtidig* · *app som holder strømforbruket under en grense
  automatisk* · *kapasitetsledd hvordan unngå tre-timers-regelen*.
- **Where they look.** hjemmeautomasjon.no forum + the "Hjemmeautomasjon"
  Facebook group (buyer-advice threads); the Homey Community Forum 🇳🇴
  Norsk + Apps; ByggeBolig el-installasjon (entered via the blown-fuse
  panic); r/norge and r/elbil for tariff venting.
- **How they arrive.** Word-of-mouth inside the Norwegian Homey channel,
  not search — a "styring med Homey eller Tibber/Vibb?" or "maks kW
  samtidig belastning" thread that points them at the dedicated-app shelf.
  They are won on **"install, set the cap, walk away."**

### 2. First-time user: the flow-burnout graduate

The newly-committed Homey owner who has just hit the wall of DIY
power-control flows. Two real figures converge here: (a) the "fersk men
frustrert" forum poster who hand-built an Advanced Flow summing device
wattage into a Temporary-Variable, gating the charger and resetting per
hour — and gave up when the price window crossed midnight and the state
machine flapped; or (b) the Tibber + Easee household that learned its
balancing only protects *one charger against the fuse*, not the
whole-home tier. **Defining trait: they do not trust the app yet** — this
is the trust-establishment window.

- **Trigger.** Usually two events in sequence: first the structural
  realisation that manual capacity management is impossible (the canonical
  *tu.no* line — "strømdata er 24 timer forsinket, og da har skaden
  allerede skjedd … har du gått over en grense, har du ødelagt for hele
  måneden"), then a concrete on-ramp incident — a fuse trip, a tier jump,
  or a hand-built Flow that flaps. The **flow-burnout** moment is the
  specific one that routes them to a dedicated app rather than to a
  hardware balancer.
- **How they phrase it.** "Jeg vil at huset automatisk holder samlet
  effekt under 10 kW når jeg lader elbilen, uten at jeg må overvåke det
  selv — og helst flytte varmtvann og lading til de billige timene. Flowen
  min ble for komplisert. Finnes det en app som bare gjør dette, sånn som
  Tibber, men for hele huset mot effekttariffen?"
- **What they Google.** *Homey Tibber Easee hvordan styre samlet effekt
  under 10kw ved lading av elbil* · *flow for maks kW samtidig belastning
  effekttariff Homey* · *smart strømstyring app Homey kapasitetsledd* ·
  *Sparegris OR Power Guard Homey effekttariff erfaring*.
- **Where they look.** Homey Community Forum 🇳🇴 Norsk (`/c/nb`) + Apps;
  hjemmeautomasjon.no + its Facebook group; elbilforum.no / Norsk
  elbilforening; r/norge, r/elbil; and the nettleie explainers they read
  *first* to understand the tariff before searching for a tool.
- **How they arrive.** A "frustrert ny bruker" / "styre samlet effekt
  under 10kw" thread where another owner says *stop coding, install a
  dedicated app*, or a direct App-Store energy-category browse after
  deciding "I already own Homey, I'll consolidate here." They arrive
  already fluent in the kapasitetsledd vocabulary, so PELS's **first-run
  screens must win trust against incumbents the user already half-trusts**.

### 3. Curious tinkerer: the frustrated Flow-builder

The technical Homey owner who *enjoys* the wiring but ran into the wall
every forum thread describes: the capacity-control Flow balloons into an
unmaintainable state machine — summed power into a Temporary-Variables
tag, hysteresis so loads don't flap, priority shedding, reconnection, and
the **midnight-crossing price window the standard cards can't handle**.
They want the engine handed to them — but will still pop every hood.

- **Trigger.** They watched their effektledd/kapasitetsledd tier creep up
  month over month and noticed it spikes "kun over 10kW når jeg lader
  Teslaen". Often a blown main fuse was the first jolt; the tariff
  realisation came second. Their instinct is to **build the rule
  themselves**, not buy a box.
- **How they phrase it.** "I want Homey to throttle the EV charger and
  shed the water heater when total draw approaches my limit, so I stop
  jumping a tier — and shift flexible load into the cheapest hours. I
  started building it as a Flow but it's *litt strevsomt å teste /
  vedlikeholde / endre*: summing the devices, stopping it flapping,
  prioritising what to drop first, and the price window that crosses
  midnight just breaks."
- **What they Google.** *flow for maks kW samtidig belastning effekttariff
  Homey* · *Homey limit total power consumption flow prioritize devices* ·
  *community.homey.app effekttariff kapasitetsledd styre forbruk* · *styre
  varmtvannsbereder Nordpool Home Assistant automasjon*.
- **Where they look.** Homey Community Forum — Norsk + the canonical "maks
  kW samtidig belastning" and "prioritize units under max level" threads;
  hjemmeautomasjon.no (Strømsparing + Automasjoner); the **Home Assistant**
  Community "limit peak energy usage" / Norway-energy threads (the
  parallel DIY destination they weigh); the "Hjemmeautomasjon" Facebook
  group.
- **How they arrive.** Word-of-mouth in the Homey forum, after exhausting
  the DIY approach. They install PELS as a **hypothesis to test**, not a
  verdict to trust — the *verify-first* branch of persona 2; once verified
  for a week, they relax into persona 1.

### 4. Skeptical optimiser: the burned single-axis veteran

The Tibber-and-Easee veteran who has outgrown single-device control. An
EV commuter (often Tesla/Easee/Zaptec) and/or hot-water-tank owner who
already runs smart charging and maybe a relay-controlled
varmtvannsbereder, knows the kapasitetsledd / effekttrinn vocabulary cold
— and **has been personally burned**. They don't need the problem
explained; they need proof a tool does what it claims, hour by hour and
krone by krone, which is exactly why they distrust the next tool too.

- **Trigger.** A concrete betrayal-by-tool event, in one of three
  canonical forms: (1) scheduled/smart charging silently failed — empty
  battery before the commute, or the car charged immediately at peak on
  plug-in instead of waiting for the cheap window; (2) a cold-shower
  surprise — the water-heater control left the tank empty for "siste mann
  i dusjen"; (3) the bill "snublet opp ett trinn" and they traced it to EV
  charging colliding with cooking. Each exposes a previously-trusted
  single-axis tool as handling price *or* fuse *or* one device — and
  failing at the seam.
- **How they phrase it.** "Jeg vil at bilen skal være ladet og klar til om
  morgenen på de billigste timene — uten at hovedsikringen ryker når jeg
  lader og lager mat samtidig, og uten å snuble opp ett effekttrinn.
  Tibber/laderen styrer bare bilen, ikke varmtvannsberederen og panelovnene
  samtidig. Og jeg vil faktisk kunne **SE** at den valgte de billige timene,
  og hva det kostet — ikke bare stole på at den gjorde det." The
  **verification demand** is the defining trait: they have been lied to by
  a schedule before.
- **What they Google.** *lade elbil klar til om morgenen billigste timer
  spotpris* · *elbillader styre etter spotpris og effektgrense
  kapasitetsledd* · *Tibber effektbalansering holder ikke under grense* ·
  *styre varmtvannsbereder etter strømpris unngå kald dusj* · *scheduled
  charging not starting EV charges immediately plugged in*.
- **Where they look.** Homey Community Forum — Norsk + Apps;
  hjemmeautomasjon.no + its Facebook group; **elbilforum.no** (Norsk
  elbilforening, the natural home for the EV-commuter cut); Home Assistant
  Community + `ev_smart_charging` GitHub issues; Tesla/MG owner forums for
  the "box-vs-car scheduling" regression; diskusjon.no / Futurehome forum
  for VVB scheduling.
- **How they arrive.** Word-of-mouth in the Homey forum, after hitting the
  flow-complexity wall or being burned by a single-axis tool. The deciding
  hook is **verifiability** the others lack — a per-hour schedule chart and
  a money figure they can audit *after* the run.

### 5. Recovering-from-mistake user: the burned automator

The person doing damage control. Before PELS they already tried to solve
capacity/price control — a hand-built Flow, a charger scheduler, a
smart-plugged water heater, or a single-device app — and got bitten by a
concrete failure. They are **not** aspirationally optimising (that's
persona 4); they don't trust the tool that failed them, and they frame it
as *fixing a broken rule*, not discovering a new product category.

- **Trigger.** A trusted automation visibly failed in a way that hit the
  household: a cold shower because the VVB relay stayed off through the
  morning, an EV uncharged before the commute despite a confirmed
  schedule, or a capacity-tier jump because two big loads coincided. The
  shared trait vs persona 4 is that this is a **post-mortem** trigger
  (something broke), not a curiosity trigger (did I save money?). The 24h
  data lag makes it worse — by the time they see the peak, the month's
  tier is set.
- **How they phrase it.** "Jeg satte opp lading/styring og det virket ikke
  — bilen var ikke ladet / det var kald dusj / sikringen røk / jeg snublet
  opp et trinn likevel." They blame their **setup**, not the concept: "min
  flow stoppet ikke berederen i tide", "planlagt lading virket ikke",
  "hvorfor lot den elbilen og komfyren gå samtidig?".
- **What they Google.** *elbil ladet ikke om morgenen planlagt lading
  virket ikke* · *Sparegris VVB styring kald dusj erfaring* · *homey flow
  stoppet ikke berederen i tide hysterese* · *snublet opp et trinn
  kapasitetsledd selv om jeg styrer forbruket*.
- **Where they look.** Homey Community Forum — Norsk app threads where
  users post config-mistake reports; hjemmeautomasjon.no (VVB-styring,
  flow-maintenance pain); diskusjon.no (Energi/Smarthus cold-shower
  threads); elbilforum.no (scheduled-charging-didn't-fire); byggebolig.no
  (hovedsikring går); and charger-vendor support (Easee "Lading starter
  ikke / stopper sporadisk") + Tesla/MG owner forums for the
  silent-schedule-failure class.
- **How they arrive.** The same forum/App-Store path as the incumbents —
  but the **decisive hook for this persona is the recovery story**: a tool
  that, after a failure, tells them *what changed, why, and which single
  setting to adjust*. That post-mortem layer is the gap they could not find
  elsewhere.

### 6. Notification-driven panic visitor: the mid-incident victim

The mid-incident victim of a tool they already trusted — the most
emotionally loaded acquisition state of all six. They are not browsing;
they are **reacting**, at the worst possible moment, to a single concrete
failure with a real-world consequence happening *now*.

- **Trigger.** A single acute failure with an immediate consequence: the
  EV is not charged the morning of a commute despite a confirmed schedule;
  OR the tank ran out and someone got a cold shower; OR the main fuse
  tripped when EV charging collided with cooking and the house went
  dark/cold. The damage is happening as they reach for their phone.
- **How they phrase it.** "Jeg satte planlagt lading i går kveld og bilen
  ladet ikke i natt — nå må jeg på jobb." / "Berederen var skrudd av og
  siste mann i dusjen fikk iskaldt vann." / "Hovedsikringen ryker hver
  gang jeg lader elbilen og lager middag samtidig." They blame the tool
  they trusted ("smartladingen virket ikke", "den ladet med en gang jeg
  satte i kontakten i stedet for å vente på de billige timene") and do
  **not** yet have the concept of whole-home capacity coordination.
- **What they Google.** *elbil ladet ikke om morgenen planlagt lading
  virket ikke* · *scheduled charging not starting EV charges immediately
  plugged in* · *varmtvannsbereder skrudd av kald dusj tidsstyring* ·
  *hovedsikringen ryker når jeg lader elbil og lager middag samtidig*.
- **Where they look.** First, charger-vendor and car-maker support (Easee,
  Zaptec, Tibber smartlading; Tesla Motors Club / Tesla Owners Online / MG
  forums); then elbilforum.no; then the Homey forum and hjemmeautomasjon.no
  once they suspect the *schedule itself* is the problem; ByggeBolig /
  diskusjon.no for the fuse-trip and cold-shower variants.
- **How they arrive.** Two distinct paths, and the distinction matters.
  **Discovery-as-acquisition** runs through the forum (after getting
  burned, they post "I want what Tibber does, but for the whole house
  against the effekttariff"). **Discovery-as-engagement-state** runs
  through the **notification deep-link** — because this persona usually
  arrives mid-incident *after* they already own and installed PELS (as
  persona 2 or 4), a Homey push drops them straight into a PELS surface
  during the next incident.

## How to regenerate the snapshot

The competitive landscape in `tmp/persona-discovery-landscape.md` is
*generated output* — this recipe is the tracked, reproducible path to
rebuild it (the snapshot file itself is intentionally git-ignored, so
this section is where a fresh checkout finds the instructions).
Regenerate when competitor line-ups or capabilities have moved (roughly
quarterly, or before any positioning/marketing pass):

1. **Seed from the demand side above** — each persona's *What they Google*
   queries are the seed set.
2. **Run a discovery sweep** (WebSearch + WebFetch, or a fan-out
   workflow) over:
   - the **Homey App Store** energy category — refresh the whole-home app
     cluster (names + what each one claims);
   - **vendor capability pages** (Tibber effektbalansering / smartlading,
     the charger-balancer vendors, smart-boiler vendors) — confirm each
     is still single-axis and re-quote any "cannot guarantee" language;
   - **Home Assistant** components (`peaqev`, `ev_smart_charging`, the
     Norwegian cost-stack HACS components) for the DIY fork;
   - **nettleie explainers** for the manual-tips layer.
3. **Adversarially fact-check** capability claims — a competitor "can't
   do X" is the easiest thing to get wrong.
4. **Write the result** to `tmp/persona-discovery-landscape.md` with a
   fresh snapshot date. Keep competitive detail **out of git**; only this
   recipe is tracked.

## Sources — demand & trigger evidence

Verified 2026-06. **(403)** = blocks automated fetch (snippet-level). The
competitive-landscape / vendor-capability sources live with the `tmp/`
snapshot, not here.

**Capacity tariff, bill shock & the 24h-lag literacy**
- tu.no — *Ny nettleie: hvordan styre effektforbruket* —
  https://www.tu.no/artikler/ny-nettleie-hvordan-styre-effektforbruket/515299
- bytt.no — nettleie-sjokket / tre-timers-regelen (the ~4 500 kr/year
  figure) **(403)** —
  https://www.bytt.no/strom/strompriser/a-bbeb/nettleie-sjokket-slik-unngar-du-at-tre-timers-regelen-koster-deg-tusenlapper
- Nettavisen — *Nettleiesjokket er bare starten* —
  https://www.nettavisen.no/norsk-debatt/nettleiesjokket-er-bare-starten/o/5-95-3069641
- NAF — lading med ny nettleiemodell —
  https://www.naf.no/elbil/lading/slik-bor-du-lade-med-ny-nettleiemodell
- Zaptec — *ryker hovedsikringen når du lader elbilen og lager middag*
  (fuse-trip trigger) —
  https://zaptec.com/ryker-hovedsikringen-nar-du-lader-elbilen-og-lager-middag-samtidig/

**Homey Community Forum — what owners ask (search/demand evidence)**
- *Homey Tibber Easee — styre samlet effekt under 10kWh ved lading av
  elbil* — https://community.homey.app/t/homey-tibber-easee-hvordan-styre-samlet-effekt-under-10kwh-ved-lading-av-elbil/68540
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
- hjemmeautomasjon.no — *anbefaling hjemmeautomasjon som styrer
  elbillader … på samme måte som Tibber* **(403)** —
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
