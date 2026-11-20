/**
 * Sets two V8 memory flags for the app process, as a relief for homes whose
 * PELS runs at Homey's per-app memory ceiling.
 *
 * Ownership: a V8-level memory lever, next to `heapReclaim.ts`. Homey's
 * watchdog counts full RSS against a 150 MB per-app ceiling, and a large home
 * keeps PELS within a few MB of it. Neither flag turns off a compiler tier:
 *
 * - `--optimize-for-size` makes V8 grow its heaps less eagerly and favour
 *   compact memory over speed where it has the choice. On a test home with
 *   46 managed devices and 9 Smart tasks, the app's own memory (RSS minus
 *   shared files) after 100 minutes fell from 91.5 to 80.8 MB.
 * - `--flush-baseline-code` lets V8 drop baseline (Sparkplug) machine code for
 *   functions that have not run recently, as it already does for bytecode.
 *   Node 22 keeps that code for the life of the process by default, so code
 *   space grew from 4.5 to 6.7 MB over two hours and kept growing; with the
 *   flag it stayed at 4.4–4.9 MB.
 *
 * Imported by `resourceWarnings.ts`, the memory-warning owner, which the app
 * entry loads statically: the flags are set while the module graph loads,
 * before most code has run. A runtime that refuses a flag keeps its default.
 */
import v8 from 'node:v8';

const MEMORY_FLAGS = ['--optimize-for-size', '--flush-baseline-code'] as const;

for (const flag of MEMORY_FLAGS) {
  try {
    v8.setFlagsFromString(flag);
  } catch {
    // The runtime keeps its default for this flag; nothing else depends on it.
  }
}
