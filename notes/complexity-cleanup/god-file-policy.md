# God-File LOC Policy

> **Status:** Proposal. Not ratified. Intended as input for tightening `max-lines` enforcement.

## Problem

The repository-wide rule is `max-lines: { max: 500 }` in `eslint.config.mjs`. Several hot-path
files are still over that limit, and some use file-level `/* eslint-disable max-lines */` pragmas.
Those pragmas hide the most important files from the rule and set no concrete ceiling.

Config-level overrides are better because they are visible in one place and can carry a target
ceiling plus a short structural justification. Several overrides now have those comments; the
remaining cleanup is to remove broad file-level pragmas or classify them as explicit exceptions.

## Policy Proposal

Each oversized file should land in one of two buckets:

- **Bucket A - must shrink to <=500 LOC.** The file accumulated accidentally. The pragma or
  override stays only until the planned shrink lands, and goes with it.
- **Bucket B - documented exception with a concrete raised ceiling.** The file stays over 500
  because the concept is intentionally centralized. The exception lives in `eslint.config.mjs`
  with a comment and a target ceiling.

No file should have both a blanket pragma and a config-level ceiling indefinitely.

## Current State Snapshot

The full list of oversized files churns constantly, so it is not frozen here. Regenerate the
current set on demand:

```bash
find lib setup flowCards drivers widgets packages/*/src app.ts api.ts \
  -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.spec.ts' \
  -exec wc -l {} + | awk '$1>500 && $2!="total"' | sort -rn
```

As of 2026-08-30 the command above reports 103 source files over the 500-LOC rule. Most are
Bucket A (accidental growth — shrink when next touched) and need no per-file note. Effective
ESLint counts run lower than `wc -l` because the rule skips blank lines and comments.

The rows worth tracking are the **Bucket B documented exceptions** — files intentionally over the
limit because the concept is centralized, which is what earns an entry in `eslint.config.mjs` with
a ceiling and rationale. There are currently two, and only one of them is over 500 for a
Bucket B reason:

| File | LOC (2026-08-30) | Where the exception lives |
|---|---:|---|
| `packages/shared-domain/src/deadlineLabels.ts` | 2868 | The one remaining blanket `/* eslint-disable max-lines */` pragma. Single home for kind-aware smart-task copy, colocated so runtime logs and the UI read the same strings. Per step 3 below it should move to a config-level ceiling. |
| `packages/settings-ui/src/ui/deviceDetail/index.ts` | 542 raw / ceiling 505 | Config-level ceiling in `eslint.config.mjs`, which records <=500 as the target it must reach. |

The 2026-05-30 revision of this table listed nine Bucket B files; none of them carries an
exception today. Five have shrunk under 500 and need none (`deviceDiagnosticsService.ts` 467,
`registerFlowCards.ts` 185, `steppedLoadExecutor.ts` 273, `targetExecutor.ts` 480,
`settings-ui/src/ui/components.ts` 245). Four are still over and are therefore Bucket A:
`deviceTransport.ts` 714 (down from 2299), `planExecutor.ts` 541 (from 822), `profiles.ts` 586
(from 590, essentially unchanged) and `priceService.ts` 566, which has *grown* from 531 — the one
row that got worse rather than better. `lib/price/nettleieFallbackData.generated.ts` (1698) is
generated and eslint-ignored.

Everything else over 500 is Bucket A: shrink and drop the file-level pragma when the file is next
touched. Use the regen command above rather than maintaining a frozen Bucket A list here.

## Migration Sequence

1. Add or keep justification comments for config-level overrides that are intentionally Bucket B.
2. For Bucket A files, shrink first and remove the file-level pragma in the same PR.
3. For Bucket B files, move any remaining blanket pragma into `eslint.config.mjs` with a concrete
   ceiling and rationale.
4. Consider flipping `max-lines` from warning to error only after the override list is authoritative.

## Review Rules

When a PR adds or raises an override:

- Is this Bucket A material? Prefer shrinking instead.
- Is the target being raised only because the file grew? Push back.
- Is there a structural justification comment? If not, block the override.
