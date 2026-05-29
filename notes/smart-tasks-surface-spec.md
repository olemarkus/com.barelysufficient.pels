# Smart tasks surface spec

Governing reference for the Smart tasks settings surface (the `deadlines`
tab: active list + Past tasks history). Written so the look and the
value-contract are decided **once** — chips conform to this, they don't
re-litigate it. Derived from a verdict-first render-gate review of the real
dark mobile surface on `main` (2026-05-29), the prior 33-chip polish train,
and an independent M3 review.

Render gate that produced this: `packages/settings-ui/tests/e2e/smart-tasks-surface-screenshots.spec.ts`
(captures the surface in dark mobile across data states; see the render-gate
cadence — run it at every workstream-PR boundary and at train end, not per chip).

---

## Truth (the value contract) — PR1 "Tell the truth"

1. **Empty-state coordination.** The active list and the history archive are
   independent render roots (`DeadlinesList.tsx` `DeadlinesListRoot` /
   `deadlinesList.ts` `renderHistorySurface`). The active list must branch on
   **whether history exists**, not only on `cards.length === 0`:
   - **First run** (no active cards AND no history): keep "Add your first smart
     task" + the Flow instructions.
   - **Between runs** (no active cards, history exists): headline
     "No smart tasks scheduled", body points down to Past tasks — never
     "first" / "No smart tasks yet". Thread a `historyPresent` signal into the
     active-list state; add the new copy to `deadlinesListHero.ts`
     (`DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE`) + `deadlineLabels.ts` — not
     inlined in the view (Rule 4: log strings track UI strings).
2. **Hit-rate legibility.** The strip excludes abandoned from the denominator
   (`deferredPlanHistoryReceipt.ts`: `succeeded/(succeeded+missed)`). Make the
   denominator legible — e.g. "50 % of 4 finished" / "50 % on-track (finished
   runs)" — so the percent reconciles with the counts beside it. Don't change
   the math.
3. **Plain copy, no internal phrasing.** Replace the Flow-card placeholder
   "… by Ready by" with the user outcome ("heat a device to a target by a time"
   / "charge a device to a target % by a time").
4. **Scope cue.** The 7-day strip is all-device + rolling; the week dividers are
   calendar. Label so the two windows don't read as a contradiction.

## Look (the M3 system) — PR2 "Apply the M3 system"

Token compliance is the floor; these are the bar. Conform to the existing PELS
tokens (do not introduce new palettes).

5. **Surface-tier ladder** — every block sits on a named tier; nothing floats
   bare on the page background:
   - page background: base canvas
   - nav / hero: `--pels-surface-container-*` per existing hero
   - cards (active + history): `pels-surface-card`
   - **the empty-state instructional copy must be IN the hero card**, not a bare
     `<p class="muted">`.
6. **Type roles** (`--pels-text-*`) — map every text style to a role; no
   hand-tuned sizes. **The empty-state instructions must be the *most* legible
   block** (supporting/primary tone), never `--pels-text-muted` (the dimmest
   tier). Mirror the pending-hero `metaLine` precedent that already uses the
   action tone, not muted.
7. **Status colour is a system, not a sticker** — apply the outcome tone to the
   whole history **row** (tonal container per the device-card pattern in
   `notes/overview-hero-spec.md`), not just the corner badge, and **colour the
   recap counts** to match. The "Why:" reason line on a Missed row must out-rank
   its metadata, not dissolve into it.
   - Succeeded → positive container/on-container (`--color-state-positive-*`)
   - Missed → warning container/on-container (`--color-state-warning-*`)
   - Abandoned → neutral / outline
   - Running/Building → primary container/on-container
8. **Colour policy — reserve `primary` (brand green) for actions and
   strong-positive state only.** It must NOT be the selected-nav fill. Demote
   the selected tab/segmented/chip selected state to a **tonal
   selected-container**, not a full saturated primary block. One green meaning,
   not three (nav + success + action).
9. **One selected-state language** across the top tabs and the device-filter
   chips (tonal container + clear pressed treatment). One separator style.
10. **Focal point & rhythm** — the history archive needs a clear entry point and
    the week dividers must out-rank the rows; outcome (not timestamp) should be
    the brightest thing in a row.

## Out of scope / keep

- The "Planning N deadlines." active hero is the reference for good hierarchy —
  match it, don't redo it.
- Week dividers (#1243), the active-card tier (#1265), and the chip row exist —
  build on them.
- Don't suggest raising the capacity hard cap anywhere (physical limit).
