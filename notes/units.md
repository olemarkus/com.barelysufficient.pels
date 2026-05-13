# Units convention

## Prefer integer watts internally; convert to kW at the UI boundary

Internal plan state, comparable signatures, dedupe keys, diagnostics payloads,
and persistence should carry power as **integer watts**. Convert to kilowatts
only at the rendering layer that has a reason to display kW (overview hero,
device cards, log lines aimed at humans).

### Why

- **Determinism.** Integer arithmetic produces exact equality. Float kW values
  drift below the noise floor (sub-100 W shimmy in headroom math, repeated
  multiplications) and turn `JSON.stringify`-based signatures into false-positive
  state changes. This is the bug `planReasonComparable.quantizeKwToW` works
  around — and the bug we should prevent at the boundary, not at every consumer.
- **Sentinel safety.** Integer 0 is unambiguous. Float `0.0` survives `===`, but
  surrounding code often treats "small float" and "0" interchangeably; integers
  remove the temptation.
- **Bucket clarity.** When we *want* a bucket (e.g. "match within 100 W"), the
  bucket lives in the W↔kW conversion (`Math.round(kw * 10) * 100`), not in
  each consumer's tolerance epsilon.
- **Serialization size.** Integers serialize shorter and compare faster than
  floats, which matters for the per-cycle signature work and the plan-history
  ring buffer.

### When kW is fine

- UI strings shown to humans (`"1.2 kW to spare"`).
- Public contract fields surfaced to the Settings UI / widgets where the
  consumer formats and displays the value.
- Configuration the user enters in kW (we accept the kW input, parse, and
  immediately convert to W internally).

### Migration posture

Existing `lib/plan/**` and `packages/shared-domain/**` types still carry float
kW fields on `DeviceReason` and `DevicePlanDevice`. Migrating the source types
to W is a much larger change and out of scope for any single slice. The
pragmatic rule until then:

- New internal state, dedupe keys, signatures, and diagnostics payloads → W.
- New helpers that pick the "right" unit → W with an explicit conversion at
  the rendering site.
- Existing kW fields stay until a focused slice migrates them.

### Reference implementation

`packages/shared-domain/src/planReasonComparable.ts` — `quantizeKwToW` rounds
kW into 100 W buckets and emits integer W. The comparable shape uses `needW`,
`headroomW`, etc. Consumers reading the source `DeviceReason` still see the
original kW fields; only the comparable carries W.
