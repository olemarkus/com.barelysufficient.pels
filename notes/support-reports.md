# Manual problem reports

The reporting owner in `lib/diagnostics/` prepares an immutable incident snapshot,
then submits it only after the user previews it and selects **Send report**.
It has no automatic triggers or analytics collection.

Reports contain the description, incident time, selected home/device, an explicitly
selected slice of persisted device activity, and allowlisted current readouts.
Activity is the state and reason PELS presented; it is not an actuator audit trail.
The default window is an hour either side of the incident, with the preceding
recorded state for each device. The wider window is the preceding 24 hours.
Current readouts retain their timestamps and are separate from incident history.
Unavailable history or current sections remain visible omissions. Area reports
never substitute Main's data where the selected area's read is unavailable.

The preview is the PELS-authored message. Homey also attaches its normal app logs.
The current collector does not dump settings, credentials, raw Homey devices, or
ordinary stdout/stderr into the message. New sections require explicit field
selection at their diagnostic projection, rather than serializing an owner object.

The authenticated prepare/read/send endpoints operate on report identifiers. Send
requires explicit consent and transmits the saved message, without recapturing
state. Homey's owner-authenticated manager API receives `{message}` at the app's
`crashlog` endpoint. Only App Store installations can submit; others can preview
and copy. No new Homey API key is required. The public
[Homey manager API](https://athombv.github.io/node-homey-api/HomeyAPIV2.ManagerApps.html#getAppStd)
documents the optional `message` string, without a size limit.

The description is limited to 1,500 characters and expected behavior to 800.
The message limit is 512 KiB of UTF-8 bytes. Homey documents no limit, but on
2026-10-24 it delivered 256 KiB and 512 KiB reports intact while a 1 MiB report got
a log id and was never delivered, so a larger report would look sent and be lost.
The largest realistic report, 1,000 activity entries, is about 400 KiB. Oversized
reports are rejected without silently removing evidence. A versioned opening marker and a closing
marker containing the report identifier let received content be checked for truncation.

At most four reports are retained in memory for 15 minutes. Preparing another
report can evict an older draft or finished report, but never an in-flight or
uncertain submission. One submission can run at a time, with a minute between
dispatches. Repeated sends of an existing identifier return its original outcome.
Timeouts and lost responses are uncertain and never automatically retried. Status
checks read PELS's saved outcome; they do not query Homey's received-report store.
App restart expires drafts and submission status. Logs record report identifiers,
sizes, and outcomes, never report content.
