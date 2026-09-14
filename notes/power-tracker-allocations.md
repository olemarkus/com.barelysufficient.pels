# Power tracker sample allocations

`recordPowerSample` accumulates one sample's energy and sample-count increments
in small maps. Budget entries in that same pass are replacements, not increments.
`trackerBucketChanges.ts` applies those changes to the retained dictionaries:
unchanged families keep their reference, and each changed dictionary is copied
once. Device histories without a change keep their references too.

This preserves the immutable snapshot contract required by `trackerStore`'s diff
base. Never replace this with in-place edits to an already-published state. Solar
sparseness, sample gaps, UTC-hour splitting, and local-day retention keep their
existing rules. The flat dictionary layout still requires copying the keys of a
changed family; this is allocation reduction, not constant-time history storage.

## Reproduction

From a checkout with dependencies installed, using the same Node version:

```sh
node scripts/benchmark-power-tracker.mjs --ref f0c7bf042
node scripts/benchmark-power-tracker.mjs
```

The fixed base is the parent before this optimization. The script compiles that
ref's source in memory, or the current worktree when `--ref` is omitted. Each
scenario runs in a fresh process: 20 metered devices, 300 samples ten seconds
apart, with six hours, seven days, or thirty days of retained history. Only the
power tracker executes; persistence and planning callbacks do nothing. It
contacts no Homey and writes no tracker state.

Samples execute back-to-back. Report duration and minor collections alongside
RSS before/after the loop and after forced collection. `rssAfterMiB` is the
footprint at the end of the burst, not a continuously sampled peak or a
production saving. Final energy is emitted after collection to keep the history
live and expose numerical equivalence. GC and allocator behaviour are noisy;
compare the same fixture and Node version and do not assert timing thresholds
in correctness tests.

## Local measurement

One run on Node v22.23.2, comparing `f0c7bf042` with this change:

| Retained hours | Duration, before → after | Minor GCs, before → after | End-of-burst RSS, before → after |
| --- | --- | --- | --- |
| 6 | 24 → 23 ms | 14 → 8 | 60.9 → 61.1 MiB |
| 168 | 243 → 20 ms | 89 → 20 | 89.6 → 61.1 MiB |
| 720 | 1,618 → 29 ms | 467 → 20 | 135.7 → 66.9 MiB |

All scenarios ended at the same 3.5 kWh (within floating-point rounding).
Post-collection RSS stayed around 57–58 MiB in both versions: this measures
transient allocation reduction, not a smaller retained data set. The improvement
increases with history size; six-hour RSS did not improve in this run.

The lazy copies use object spread once per changed dictionary. The narrow lint
exceptions document that the copy cannot recur on subsequent loop iterations.
Replacing these copies with `Object.assign` substantially increased allocation
and elapsed time in this fixture (720 hours: 790 ms and 416 minor GCs).

## Production follow-up

The actual Homey saving remains unmeasured until this change is deployed. Compare
RSS/PSS, post-collection floors, memory-warning-triggered collections, and
`power_sample_bookkeeping_ms` at matched uptime, history size and device load.
Restarting alone reduces RSS. Leave the existing collection safeguard in place
while measuring. The remaining settings-store migrations in `TODO.md` are
separate work; this change does not complete them.
