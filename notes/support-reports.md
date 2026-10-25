# Problem reports

The reporting owner in `lib/diagnostics/` prepares an immutable incident snapshot
when the user selects **Send report**, and the settings UI sends it straight away.
The UI shows the user's own description, not the captured report, which is not
written for people to read.

The only other sender is the daily report, and only when the owner turned it on
(Settings → Advanced → Diagnostics reports, the `daily_diagnostics_report` setting;
off by default, offered on every install). Homey files every report as submitted by
the user, and the switch is what makes that true of a report nobody pressed Send for
(owner, 2026-10-25). No incident sends a report on its own, and there is no analytics
collection. A report says which it is: `trigger` is `owner` or `daily`.

Reports contain the description, incident time, selected home/device, an explicitly
selected slice of persisted device activity, the device events PELS kept, PELS's
kept log, and allowlisted current readouts.
Activity is the state and reason PELS presented; it is not an actuator audit trail.
The default window starts an hour before the incident, the wider one 24 hours
before it, and both run to capture: owners report after the fact, and what followed
the incident, such as a car reporting its plug-in hours late, is often what explains
it. Activity keeps the preceding recorded state for each device.
Current readouts retain their timestamps and are separate from incident history.

Device events (`lib/diagnostics/deviceEventStore.ts`) are what PELS observed and
decided about a device, in its structured-log event's shape, kept beside the
activity history in the userdata database for 7 days and 200 events per device. A
device report includes every kept event about the device and its related devices
(the cars that may pair with a charger, or the chargers that selected a car),
whatever the report window: a missed car link is explained by a plug-in and a timeout
that may lie hours before the reported time. A report carries at most 300 of them,
about 150 KiB, keeping those nearest the incident and stating how many it left out. The car link records
plug-ins and unplugs on both sides, each wait to identify the connected car, the
timeout with the cars it waited for and why past matches did not decide, and a
selected car that reported its plug-in after the window. A charger or car report
also carries the current car link (`Current car link`).
Unavailable history or current sections remain visible omissions. Area reports
never substitute Main's data where the selected area's read is unavailable.

The message is PELS-authored. Homey also attaches the app's log, but only its last
100 stdout and 100 stderr lines (seen on a Homey Pro, 2026-10-25), a few minutes on
a busy install. Evidence for anything older has to be in the message.

So PELS keeps its own log (`lib/diagnostics/logTailStore.ts`): every info, warning and
error line, never debug, in the userdata database for up to 48 hours and 6,000 lines,
trimmed every 100 writes rather than with each line.
The info level writes a few hundred kilobytes a day; the opt-in debug topics can write
megabytes an hour. A flood is cut at 20 lines of one event for one device per hour,
and the cut lines are counted in memory and written when the count doubles and when
the hour ends, so a flood costs a handful of writes and a report still says the lines
happened. Lines are written as they happen, because Homey exits the process before
`onUninit` runs; lines from the start of a boot wait in memory until the database
opens, and a line logged while another store holds a transaction waits for the next
write. A report carries the newest kept lines of its window that fit 256 KiB, read
newest first so a day of log is never built in memory only to be cut, and says how
many older ones it left out.
The current collector does not dump settings, credentials or raw Homey devices into
the message, and of stdout only the structured lines it kept. New sections require explicit field
selection at their diagnostic projection, rather than serializing an owner object.

The authenticated prepare/read/send endpoints operate on report identifiers. Send
requires explicit consent and transmits the saved message, without recapturing
state. Homey's owner-authenticated manager API receives `{message}` at the app's
`crashlog` endpoint. Only App Store installations can submit; for others the UI
offers Copy report, which shows the text only when the clipboard is unavailable. No new Homey API key is required. The public
[Homey manager API](https://athombv.github.io/node-homey-api/HomeyAPIV2.ManagerApps.html#getAppStd)
documents the optional `message` string, without a size limit.

The description is limited to 1,500 characters and expected behavior to 800.
The message limit is 512 KiB of UTF-8 bytes. Homey documents no limit, but on
2026-10-24 it delivered 256 KiB and 512 KiB reports intact while a 1 MiB report got
a log id and was never delivered, so a larger report would look sent and be lost.
The largest realistic report, an app report with 1,000 activity entries, is about
400 KiB. A device report carries at most 100 activity entries and 300 kept events,
together about 190 KiB. The kept log comes on top. A report that would
outgrow the limit leaves out the oldest log lines first and says how many. An owner's
report still too large without any log is rejected, and no other evidence is cut: the
owner can choose one device or a shorter window. Nobody can do that for the daily
report, so it then leaves out its oldest activity too, and says how many. A versioned opening marker and a closing
marker containing the report identifier let received content be checked for truncation.

At most four reports are retained in memory for 15 minutes. Preparing another
report can evict an older draft or finished report, but never an in-flight or
uncertain submission. One submission can run at a time, with a minute between
dispatches; the minute starts with a report Homey may have taken, so one it refused
can be sent again at once. Repeated sends of an existing identifier return its original outcome.
Timeouts and lost responses are uncertain and never automatically retried. Status
checks read PELS's saved outcome; they do not query Homey's received-report store.
App restart expires drafts and submission status. Logs record report identifiers,
sizes, and outcomes, never report content.

## The daily report

A report about the whole app, the activity of every device and every kept device
event and log line from the last 24 hours through capture, with the problem text
saying it was sent because the owner turned it on (`SupportReportService.sendDaily`).
`lib/diagnostics/dailyReportSchedule.ts` checks every hour, first 15 minutes after
start so a report never captures a half-started app. When the next one is due lives
in the userdata database and is written before sending, as if the report goes out,
so a restart mid-send or a failed write afterwards never sends it twice; a write that
fails before sending sends nothing. A due time more than a day ahead was written while
the clock ran ahead, so it counts as due. The next is due 23.5 hours later: a day, less half
the hourly check, so the report stays on the same check instead of drifting later each
day, and an uncertain one is never sent again. One Homey refused or that could not be
prepared tries again 3 hours later. An install that cannot send at all (anything but
an App Store install) captures nothing and checks again a day later. The switch is
read again once the report is prepared, so turning it off meanwhile sends nothing.
