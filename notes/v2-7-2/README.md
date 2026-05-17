# v2.7.2 — Smart Tasks become desirable

A PR-train milestone targeted at the Smart-tasks surface (landing list +
live plan + history detail). Lives on the long-lived `v2.7.2` integration
branch in parallel with v2.7.1 polish on `main`; final merge to `main`
once the train is complete.

This note is the **train logbook**: theme, scope, PR sequencing, status.
The deep design rationale lives in `notes/smart-task-ui/README.md`
(2026-05-16 live-Homey walk); read that first.

## Theme

> Turn the Smart-tasks list and the plan/history detail into something
> users actually desire to open.

`notes/smart-task-ui/README.md` names the design move:

> **Failed runs deserve a different page shape than succeeded runs.**

Today the surface serves the set-and-forget heat-tank owner well and the
missed-notification panic visitor poorly. The data is already captured
(diagnostic reason codes, observed intervals, hourly prices, planned
hours, learned kWh-per-unit); only rendering and copy are missing.
v2.7.2 lands the data plumbing that the trio needs (history schema
v3 → v4) and the asymmetry-thesis trust signals (cost, postmortem,
delivered-so-far, miss-streak) on top.

## Personas served by this milestone

From `notes/smart-task-ui/README.md`, ranked by gap-to-close:

1. **Notification-driven panic visitor** — lands on a missed-deadline
   page that today says date + chip + device and nothing about *why*.
   v2.7.2 lands the one-sentence postmortem (PR 3) and recourse CTA.
2. **Recovering-from-mistake user** — opens after a miss streak. v2.7.2
   adds the miss-streak aggregate on the landing page (PR 6) so the
   pattern is visible without mental aggregation.
3. **Skeptical EV commuter** — daily after charging. v2.7.2 adds cost
   (PR 2 + 3), delivered-so-far (PR 2), picked-N-of-M (PR 7), and
   actual-vs-plan trajectory (PR 4).
4. **Curious tinkerer** — adequately served today; PR 5's revision log
   answers the "did PELS change the plan, and why?" question more
   directly.

## Scope

In scope (TODO line refs into `TODO.md`):

| Line | Item |
|---|---|
| L1215 | History-detail rebuild around actual-vs-plan progress samples |
| L1249 | `deliveredKWh` + `totalCost` on the history entry |
| L1260 | Real revision log on history detail |
| L2121 | History → live-plan chart parity |
| L2133 | One-sentence postmortem on missed history detail |
| L2155 | `Cost ≈ X kr` on live hero, past list, history detail |
| L2167 | "Picked N cheapest of M" caption on live chart |
| L2179 | "Delivered so far" strip on live hero |
| L2191 | Overshoot line on Succeeded history entries |
| L2205 | Miss-streak aggregate on landing page |
| L2216 | One chart vocabulary across live and history |
| L2228 | Cross-link from history detail → Usage same-day chart |
| L915  | Drop redundant "SMART TASKS" eyebrow above the h2 |
| L1383 | Chart styling parity (active vs history) |
| L1393 | "Cannot finish" repeated 3× cleanup |
| L1987 | List ↔ detail chip-tone reconciliation |

### 2026-05-17 scope expansion — PR #856 follow-ups absorbed

PR #856's release review surfaced one P1 and three P2 gaps in the
shipped Smart-tasks surface. Rather than land them as separate v2.7.1
patches (the release was already delayed), we fold them into this train
so the train ships one coherent Smart-tasks refresh:

| Severity | Item | Lands as |
|---|---|---|
| P1 | Pending hero missing `headlineReason` + `recourse` | **PR 2.5** (this entry) |
| P2 | Past list missing cost + miss-streak quick aggregate | folded into PR 3 / PR 6 |
| P2 | History detail missing one-sentence postmortem hooks beyond Missed | folded into PR 3 |
| P2 | History detail revisions list omits "what changed" wording | folded into PR 5 |
| P2 | Live chart picked-N captioning verbosity | folded into PR 7 |

Out of scope (kept on their current tier):

- `notification_text` token on `deadline_ended` flow trigger (P3, L2440)
- Live → completed → history in-place transition (P3, L2455)
- Hard-deadline enforcement / mode override
  (`notes/hard-deadlines/README.md`)
- P1 EV items currently slated for v2.7.1 (L689 / L705 / L734)

## PR sequencing

```
PR 0  branch + CI + theme note + TODO claim banner  (this PR)
  │
PR 1  history schema v3 → v4 (contract + recorder + migration; no UI)
  │
  ├── PR 2  cost + delivered-so-far on live hero
  │     │
  │     └── PR 3  postmortem + outcome-asymmetric history hero + cost
  │           │
  │           └── PR 4  actual-vs-plan chart rebuild on history detail
  │                 │
  │                 └── PR 5  live page parity + revision log
  │
  └── PR 6  list-level desirability + Usage cross-link
        │
        └── PR 7  picked-N-of-M + version bump 2.7.2 + changelog + close
```

Each PR is squash-merged into `v2.7.2`. `v2.7.2` rebases onto `main`
after every two merges to avoid late drift.

## Product-critique gate

Every PR in this train that touches `packages/settings-ui/**` dispatches
the `pels-ux-fit` subagent before push, framed around the page mission
the PR is meant to serve. This is a *mandatory* product gate, not an
optional one — desirability is the success metric, and correctness gates
(`adversarial-review`, `pels-m3-critic`, `pels-copy-and-terminology`)
catch correctness, not product weakness.

Page missions per PR:

| PR | Page mission |
|---|---|
| 2 | Live plan detail — "what's next, what's happened, what will it cost?" |
| 3 | History detail (missed) — "why did this run miss, and what should I do next?" |
| 3 | History detail (succeeded) — "did it actually succeed, and at what cost?" |
| 4 | History detail (any outcome) — "can I see actual progress against the planned trajectory at a glance?" |
| 5 | Live + history detail — "did PELS change the plan, when, and why?" |
| 6 | Smart-tasks landing — "are my deadlines on track, and is any device failing a pattern?" |
| 7 | Live plan detail — "did PELS actually pick the cheap hours?" |

P0/P1 findings from any critic: fix in the same PR. P2/P3: route to
`TODO.md` under the v2.7.2 section.

## Status log

| Date | PR | Status |
|---|---|---|
| 2026-05-17 | PR 0 | branch + workflow trigger + theme note + TODO banner |
| 2026-05-17 | PR 1 | history schema v3 → v4 — progressSamples + kWhPerUnitMean + deliveredKWh/totalCost + revisions[] |
| 2026-05-17 | PR 2 | cost + delivered-so-far on live hero — `Σ priceValue × deviceKwh`, two-branch delivery copy |
| 2026-05-17 | PR 2.5 | pending hero `headlineReason` + `recourse` — scope expansion absorbing PR #856 P1 |

Update as PRs merge into `v2.7.2`.

## Related notes

- `notes/smart-task-ui/README.md` — the strategic foundation. Read first.
- `notes/deferred-load-objectives/README.md` — shared objective model,
  reason codes, status semantics.
- `notes/smart-task-flow-cards/README.md` — flow card design and the
  rejected `notification_text` discussion (revisit for the missed-case
  P3 item if v2.7.3 picks it up).
- `notes/objective-profile-bands.md` — the band math that PR 4's
  planned-staircase trajectory derives from.
- `notes/ui-terminology.md` — canonical chip / state / kind copy that
  every PR in the train must respect.
