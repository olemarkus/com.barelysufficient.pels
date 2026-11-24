# Shared charging installations

Some chargers take their current from an installation they share with other chargers: one
available current for the installation, which the installation's own load balancing shares between
the cars that are charging. Zaptec is the first such integration. Its app sets the installation's
available current through `available_installation_current`, the installation-current Flow card,
and each charger's `target_power` in `homey` mode alike, while starting and stopping charging
(`evcharger_charging`) stays per charger. Zaptec recommends one shared installation for chargers on
one supply (up to three Go chargers in a home installation), because separate installations turn
its load balancing off.

PELS can control the shared current while retaining each charger's own switch, battery level and
smart tasks. Installations that cannot be managed together keep individual switching and Flow
current control.

## Terms

- **Installation**: the chargers that share one available current.
- **Member**: a charger on an installation.
- **Main**: the one member through which PELS sets the installation's current. It is the only
  member whose watt mode PELS takes over and the only one PELS writes a current or watt target to.
- **Secondary**: every other member. Its current follows the main's setting; PELS switches it but
  never sets its current.

In UI copy "main" is not used, because **Main** names the main home.

## When it applies

A shared installation is controlled this way only when every member is:

- managed by PELS, with Power-limit control on, and
- identified by its integration's own charger id, and
- assigned to the same resolved meter area as the other members.

The main also needs a usable current-control route and ladder. An unavailable main
that still appears in a complete inventory retains its role.

An enabled current-setting Flow on any member sets the route for the whole installation. Each
member keeps its own switch and any Flow current control, and PELS sends no built-in current or
watt writes. The same fallback applies when every member is controlled and the main has no shared
route. Installations with some unmanaged members keep their existing routes when no Flow sets
shared current. PELS blocks current control until the first successful Flow scan, while meter-area
ownership is unresolved, when members span meter areas, or while the main's automatic watt claim
is refused. During a refused claim, the main's card can explain why only switching is available.

The main is the member with the lowest integration charger id. That id survives a re-pair, unlike
the Homey device id, so the main does not move when a charger is re-paired. It is recomputed from
each full device read. While the main is unavailable, the installation keeps its last current.
PELS pauses the members it can reach when it needs to shed. It resumes them when there is room
for the full retained assignment and waits for the main if that assignment is unreadable or zero.

## What is shared and what is not

| Concern | Shared by the installation | Per member |
| --- | --- | --- |
| Charging current | One ladder, set through the main | — |
| Capacity shedding and restoring | Through the installation's ladder | — |
| Which car charges at low current | The installation's load balancing | — |
| Starting and stopping a car | Bottom step pauses chargers that should be charging | Own switch, for a target or the owner |
| Priority | Pegged across members | Each member keeps its own row |
| Draw | Summed for planning | Own observed draw everywhere else |
| Car association, state of charge | — | Own |
| Smart tasks | — | Per car |

### Capacity

When the main is available and the shared level can be read, the installation is one stepped
load for capacity. Its ladder is the main's ladder (Off, then the
installation's current steps), read at the installation's actual level: the main's watt target in
`homey` mode, or the installation's available current. Shedding steps it down first, as for any
stepped load. Off is the bottom step and pauses the chargers that should be charging. Restoring climbs the same ladder.
If the installation is drawing and its level is unreadable, PELS can pause the reachable chargers
directly. When the installation is off and the main is available, PELS can prepare a known current
before resuming.

PELS does not order cars within the installation. At low current the installation's load balancing
lets only as many cars charge as can each get the minimum (6 A), the earliest session first, and a
car that draws less or finishes leaves its share to the others. PELS assumes the installation uses
its whole assigned current.

### Per-charger switching

Each member keeps its own switch for two things:

- **A car at its smart-task target.** PELS stops that member, and the others take the whole
  installation current.
- **The owner's own choice.** Turning one charger off in PELS, or "Leave off until turned on
  again", stays per charger.

The installation's bottom step and its restore switch only members that should be charging. A
member held off by its own task or by the owner stays off.

#### Configured current ranges

The shared current assignment is bounded by the highest configured minimum and
lowest configured maximum of the cars that may charge, so one car can safely
take the whole assignment when its peers pause. A plugged-in car may resume at
the same current and keeps its range in the calculation while paused. A car
that has finished or unplugged releases its range. An empty intersection holds
the charging switches off. Load balancing still decides the current each car
actually draws.

## Priority

PELS cannot shed one member before another, so the members share one priority. Each member stays
its own row in the priority list, because its car association and state of charge are its own.
Moving one member moves the whole group. The rows are adjacent in the mode order and show the
same priority. Each row explains that it shares its priority with the other chargers.

### Smart tasks

Battery-level tasks stay per car. The installation's current serves every member whose task is
running. A task's permission affects the shared capacity decision, while exempt
energy is attributed to the charger that actually draws it. Startup power is
reserved once for the installation. When a car reaches its target, PELS stops that member's charger. No task promises which
car is served first.

## Ownership

- **Device layer.** The integration's adapter resolves membership, main selection by its charger
  id, the write route, and which capabilities each member exposes: watt control on the main only.
  It publishes one vendor-neutral fact per member on the device snapshot: installation id, role
  (main or secondary), main id and member ids. Writes of current or watt targets to a secondary are
  refused at the write seam. Nothing outside the device layer and the adapter registry knows the
  vendor.
- **Planner input** (`lib/planInput/`) is the only place the installation becomes one load. The
  main's entry carries the installation's ladder at its actual level and the members' summed draw.
  Members keep their own entries for their switches, tasks and cards, but do not count as separate
  capacity steps or draw. Smart-task decisions use each member's own input before the planner
  substitutes the installation's capacity readings.
- **Executor.** A capacity step goes to the main's current or watt target. The installation's
  bottom step and restore reach the members that should be charging. A per-member switch reaches
  that member only.
- **Observation** is unchanged. Each member's observed draw, state and history stay its own:
  cards, history, Insights, learned peaks, phase footprint, car link, smart-task energy and idle
  detection all read the member.

## Cards and setup

- **Main's card:** shows its own car's draw and, on the same power line, the installation total
  ("3.2 kW · installation 10.4 kW"). When no other reason needs the line it reads "Sets the
  available current for this installation."
- **Secondary's card:** shows its own state from its own observation:
  - Running · Charging while its car draws;
  - Idle · Waiting for current while its car asks for power and none reaches it;
  - Off · Not charging or Off · Unplugged otherwise.

  Its reason line reads "Its current is set through <main's name>. The chargers share the available
  current between the cars that are charging."
- **Setup → Charging current:** stops offering only "Use a Flow" for a fully managed shared
  installation. It explains that PELS sets the installation's current through one charger.
  `docs/zaptec-ev-charger.md` and `docs/ev-charger.md` change with it.

Wording follows `notes/ui-terminology.md`.

## Logging

- `charging_installation_resolved` (info): an installation formed or changed. It carries the
  installation id, control (one load or per charger), main, members and unmanaged members.
- `charging_installation_main_changed` (info): the main moved. Nothing is written to the previous
  main; PELS never writes `device` mode.
- `charging_installation_switch` (info): an installation-level pause or restore, with each
  member's outcome.
- `charging_installation_planned` (debug, `plan` topic): each rebuild's level, total and per-member
  draw.

## Accepted behaviour

- Taking over the main's watt mode applies its held watt target. A target of 0 W stops the main's
  car once; PELS restarts it when there is headroom.
- PELS keeps its ordinary write cadence for the installation current.
- A member that leaves the installation, or a main that changes, can be left in `homey` mode with
  PELS's last watt target, as an already-claimed charger is today.

## Done when

SDK end-to-end cases cover, for a two-member installation:

- stepping down the installation's current before pausing it, with no write to a secondary;
- a secondary drawing while the main's own car is idle still being limited;
- one car reaching its target stopping only its charger, while the other keeps charging and takes
  the installation's current;
- a member held off by the owner staying off through the installation's restore;
- moving one member's priority moving the other;
- a mixed installation (one member unmanaged, or Power-limit control off) behaving as today.

The member cards read as above at 320 px wide.
