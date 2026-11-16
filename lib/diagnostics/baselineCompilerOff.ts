/**
 * Turns off V8's Sparkplug baseline compiler for the app process.
 *
 * Ownership: a V8-level memory lever, next to `heapReclaim.ts`. Homey Pro's
 * watchdog counts full RSS against a per-app ceiling, and PELS reaches it.
 * Sparkplug compiles every warm function to machine code and Node 22 never
 * flushes that code (`--flush-baseline-code` is off), so compiled code grew
 * from 6.5 to 8.2 MB over two hours on a 200-device test home and kept
 * growing. Measured 2026-11-10 on SHS (same build, same home, two hours each):
 * code 8.2 → 3.9 MB and private memory (RSS minus shared files) 92-101 →
 * 55-62 MB, with planning, device refresh and the 10 s control loop unchanged.
 * The process uses close to no CPU, so the interpreter plus TurboFan for hot
 * code is enough.
 *
 * Imported by `resourceWarnings.ts`, the memory-warning owner, which the app
 * entry loads statically: the flag is set while the module graph loads, before
 * any function has run often enough for Sparkplug to compile it. Setting it
 * after V8 starts only affects code compiled from then on, which is what this
 * wants. A runtime that refuses the flag keeps its default.
 */
import v8 from 'node:v8';

try {
  v8.setFlagsFromString('--no-sparkplug');
} catch {
  // The default compiler stays on; nothing else depends on this.
}
