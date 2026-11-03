# Passive heating diagnostics

`lib/diagnostics/heatingShadowCollector.ts` records, at each accepted meter
sample, the held observations of managed heating devices with temperature and
reported direct power (`heatingShadowIngest.ts` decides which). The power
sample pipeline hands it each sample as its own call, beside the battery demand
tap; the chronological buffer is separate from objective learning and from the
power tracker, and has no consumer in model fitting, planning or device control.
It runs independently of price strategy and task activity; no device refresh or
additional SDK read is performed.

Only the Main home is collected, and always (owner decision, 2026-11-03): a
meter area's heaters are not, since only the Main report carries the section,
and collection does not wait for the daily report switch, so the first daily
report after the owner turns it on carries the latest completed day.

The collector targets 15-minute intervals with actual endpoint timestamps,
temperature means and integrated electrical input. A held unchanged power level
remains usable; a missing reading is never zero. Gaps over five minutes interrupt
the window at its last accepted endpoint. Target/control changes, power changes
of at least 0.1 kW and zero crossings are retained separately. Ingest timestamps
describe held observations, not new sensor events. The temperature sensor role
is unclassified. Outdoor context is shared and has explicit unavailable markers;
original weather source timestamps are unresolved.
After delayed hydration, a restart gap's unavailable marker starts one
millisecond after the last accepted observation; it is an availability boundary,
not a fabricated weather measurement. A backward clock correction starts a new
chronological buffer so future-dated samples cannot stall collection.

The collector retains the current and two completed local days, respecting
DST. Calendar rotation selects at most 16 devices daily from a bounded pool of
64 eligible ids. Each device-day keeps at most 128 intervals and 256 significant
changes; each day keeps at most 256 outdoor points. Counts and gaps disclose
omitted evidence. A signal change freezes that device-day rather than relabelling
previous observations.

Persistence is diagnostics' own userdata table (`heatingShadowStore.ts`,
`heating_shadow_rows`), with separately keyed immutable observations, open
windows and small metadata. A checkpoint at most once a minute updates the
changing rows rather than rewriting completed history; nothing is flushed at
shutdown, so a stop loses at most the last minute. Rows that do not rebuild a
state in the canonical layout are deleted together and collection starts
again; the power tracker's billing and learned state never see them, and a
tracker reset does not clear them. The stored observations are read before the
first sample is recorded, so a restart continues them. A read that fails then
is retried at each checkpoint while collection carries on in memory, nothing is
written until it succeeds, and the merge (`heatingShadowMerge.ts`) then retains
disjoint historical evidence without joining observation gaps. Reconciled
omission/interruption counts are conservative lower bounds where histories
overlap. Test builds of 3.28 kept these rows in the tracker's scalar table; the
tracker store deletes them when it opens.

When the owner enables existing daily reports, Main app reports include
**Daily heating observations** for the latest retained completed day. The compact
section preserves precision and actual durations within 64 KiB of uncompressed
JSON. Whole device-day blocks are selected in the collector's calendar order;
omitted devices and local caps remain explicit. If the complete daily report
would exceed its existing 512 KiB limit, the optional heating section is omitted
before ordinary report evidence is trimmed. An omission note is added when it
fits without displacing ordinary evidence. Manual and event
reports do not include it. Collection introduces no new setting or consent path.

The input integral is derived from reported power, not an independent energy
meter. These observations support later cross-home identification and forecast
validation; they do not establish physical heat capacity, idle losses or stored
hot-water energy on their own.
