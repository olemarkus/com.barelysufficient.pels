/**
 * Sets V8 memory flags for the app process, as a relief for homes whose PELS
 * runs at Homey's per-app memory ceiling.
 *
 * Ownership: a V8-level memory lever, next to `heapReclaim.ts`. Homey's
 * watchdog counts full RSS against a 150 MB per-app ceiling, and a large home
 * keeps PELS within a few MB of it. No flag turns off a compiler tier:
 *
 * - `--optimize-for-size` makes V8 grow its heaps less eagerly and favour
 *   compact memory over speed where it has the choice. On a home with 46
 *   managed devices and 9 Smart tasks, the app's own memory (RSS minus shared
 *   files) after 100 minutes fell from 91.5 to 80.8 MB.
 * - `--flush-baseline-code` lets V8 drop baseline (Sparkplug) machine code for
 *   functions that have not run recently, as it already does for bytecode.
 *   Node 22 keeps that code for the life of the process by default, so code
 *   space grew from 4.5 to 6.7 MB over two hours and kept growing; with the
 *   flag it stayed at 4.4–4.9 MB.
 * - The compile flags keep V8's compilation on the main thread instead of its
 *   background workers. Homey Pro runs apps on glibc, which gives each thread
 *   that allocates its own arena. A compile burst grows a worker's arena by
 *   several MB and frees nearly all of it, but the few chunks left at its end
 *   keep the whole range resident, and nothing returns it. On an arm64 Homey
 *   Pro runtime with the same home, worker arenas held 16.9 MB of which
 *   1.2 MB was live; with these flags they held 10.8 MB, and RSS settled at
 *   127-128 MB instead of 138-139 MB with no change in CPU. The compile work
 *   is the same; it now runs on the main thread, whose heap glibc trims.
 *
 * Imported by `resourceWarnings.ts`, the memory-warning owner, which the app
 * entry loads statically: the flags are set while the module graph loads,
 * before most code has run. A runtime that refuses a flag keeps its default.
 */
import v8 from 'node:v8';

const MEMORY_FLAGS = [
  '--optimize-for-size',
  '--flush-baseline-code',
  '--no-concurrent-recompilation',
  '--no-lazy-compile-dispatcher',
  '--no-parallel-compile-tasks-for-lazy',
  '--no-parallel-compile-tasks-for-eager-toplevel',
] as const;

for (const flag of MEMORY_FLAGS) {
  try {
    v8.setFlagsFromString(flag);
  } catch {
    // The runtime keeps its default for this flag; nothing else depends on it.
  }
}
