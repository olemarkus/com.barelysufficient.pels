# Documentation Images

These files are hand-maintained documentation screenshots or Flow examples. Refresh them only when the screenshots themselves are being updated; the current color/theme pass is intentionally deferred.

## Referenced Flow examples

- `howto_book_cheap_hours_flow_example.png` — `docs/how-to-book-cheap-hours-with-flows.md`
- `howto_ev_charger_flow_example.png` — `docs/ev-charger.md`
- `howto_hoiax_stepped_load_flow_example.png` — `docs/how-to-headroom-expected-power-flow-control.md` (page title: Wire a Flow-Based Load Device)
- `howto_zaptec_ev_charger_flow_example.png` — `docs/zaptec-ev-charger.md`
- `howto_virtual_thermostat_flows.png` — `docs/how-to-virtual-thermostat-power.md`

## Archived Flow examples

These screenshots are kept for older Flow patterns or future docs, but are not currently referenced by a public page:

- `howto_expected_power_sync_flow_example.png`
- `howto_headroom_control_flow_example.png`

## Referenced setup screenshots

- `power-source-homey-energy.png` — `docs/homey-energy.md`
- `price-homey-energy-settings.png` — `docs/homey-energy.md`
- `price-source-homey-energy.png` — `docs/homey-energy.md`
- `howto_virtual_thermostat_capabilities.png` — `docs/how-to-virtual-thermostat-power.md`

## Archived setup screenshots

These screenshots are kept for older setup paths or future docs, but are not currently referenced by a public page:

- `power-source-flow.png`
- `price-source-norway.png`

## Generated UI screenshots

Public screenshots live under `docs/public/screenshots/`. Smart-task widget images are captured from the built widgets with example data by `npm run docs:widget-screenshots`. The creation sequence covers device selection, quick targets, the custom goal form, and the preview. Captures use an English 24-hour locale so chart labels fit the mobile card.

Smart-task plan screenshots live under `docs/screenshots/deadline-plan/` and are referenced by `docs/smart-tasks.md`. Refresh them with `PELS_TEST_WORKERS=1 PELS_PLAYWRIGHT_WORKERS=1 PELS_CAPTURE_SCREENSHOTS=1 npm run test:e2e:capture -- deadline-plan-screenshots.spec.ts`. The capture includes task actions, the power guarantee and estimate, and what happens when the task is done.
