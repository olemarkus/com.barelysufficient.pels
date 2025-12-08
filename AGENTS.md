# PELS - Price and Energy Load Shifting

A Homey app for managing power capacity and price-based energy optimization.

## What This App Does

PELS helps users stay within their electricity capacity limits (effekttariff) by automatically controlling devices based on:
- **Capacity management**: Shed devices when approaching hourly kWh limits
- **Price optimization**: Adjust device temperatures based on electricity spot prices

## Tech Stack

- **Runtime**: Homey SDK v3 (Node.js)
- **Language**: TypeScript (strict mode)
- **Testing**: Jest with mock Homey SDK
- **Build**: esbuild via `homey` CLI
- **Types**: `@types/homey` for SDK types (but `homey-api` has no types)

## Project Structure

```
app.ts              # Main app - ALL core logic lives here (intentionally monolithic)
capacityGuard.ts    # Capacity monitoring, extracted for testability
drivers/            # Homey device drivers (pels_insights virtual device)
settings/           # Settings UI (separate TypeScript build)
test/               # Jest tests with mock Homey SDK
  mocks/homey.ts    # Mock implementation - update when using new Homey APIs
.homeycompose/      # Homey app manifest fragments (merged into app.json on build)
```

## Key Concepts

### Capacity Management
- **Hard cap**: The contracted grid capacity limit (kW). Exceeding this for the hour triggers penalties (effekttariff). Only meaningful as a full-hour energy estimate, not instantaneous power.
- **Soft limit**: Dynamically calculated power limit - "if we consume this much for the remainder of the hour, we'll stay below the hard cap"
- **Headroom**: Available power (kW) before hitting soft limit (soft limit - current power)
- **Shortfall**: Triggered when estimated hourly usage will exceed hard cap AND no more devices can be shed
- **Shedding**: Turning off devices to reduce load (lowest priority first)
- **Restore**: Turning devices back on when headroom allows (highest priority first)
- **End-of-hour mode**: Last 10 minutes cap burst rate to sustainable rate

### Price Optimization
- Spot prices from hvakosterstrommen.no (Norwegian electricity prices)
- Grid tariffs (nettleie) from NVE API
- Temperature deltas applied during cheap/expensive hours

### Modes
- User-defined modes (Home, Away, Night, etc.)
- Each mode has device priorities and target temperatures
- Priority 1 = most important = shed last, restore first

## Development Commands

```bash
npm install          # Install dependencies
npx lint-staged      # Pre-commit hook: ESLint + type check on staged files
npm test             # Full test suite (pre-commit)
npx tsc --noEmit     # Type check (extra safety if needed)
```

Note: Do not run `homey` CLI commands - these deploy to hardware and should be run manually by the user.

## Writing Tests

- Tests use `test/mocks/homey.ts` - if you use a new Homey API, add it to the mock
- Create app instance with `new PelsApp()` and call `await app.onInit()`
- Access internal state via `(app as any).propertyName` when needed
- Mock time with `jest.useFakeTimers()` for time-dependent tests

## Code Conventions

- `app.ts` currently contains most logic - consider extracting modules for testability (like `capacityGuard.ts`)
- Use `this.log()` for user-visible logs, `this.logDebug()` for debug (controlled by DEBUG_LOG)
- Settings keys use snake_case (Homey convention)
- Flow card arguments use snake_case (Homey convention)
- Prefer explicit types over `any`, but `homey-api` responses need `any`

## Common Pitfalls

- **Two Homey packages**: `homey` (SDK) vs `homey-api` (device control) - don't confuse them
- **Dry-run mode**: Check `capacity_dry_run` setting - devices won't actuate if enabled
- **Mock updates**: New Homey SDK methods need to be added to `test/mocks/homey.ts`
- **Pre-commit hooks**: All commits must pass ESLint, TypeScript, and tests

## Settings Keys

| Key | Type | Description |
|-----|------|-------------|
| `capacity_limit` | number | Hard limit in kW |
| `capacity_margin` | number | Soft margin in kW |
| `capacity_dry_run` | boolean | Prevent actual device control |
| `operating_mode` | string | Active operating mode name |
| `capacity_priorities` | object | `{ [mode]: { [deviceId]: priority } }` |
| `mode_device_targets` | object | `{ [mode]: { [deviceId]: temperature } }` |
| `price_area` | string | NO1-NO5 price zone |
| `price_optimization_settings` | object | Per-device price deltas |

## Flow Cards

- **Actions**: `report_power_usage`, `set_capacity_limit`, `set_capacity_mode` (operating mode)
- **Conditions**: `has_capacity_for`, `is_capacity_mode` (operating mode)
- **Triggers**: `capacity_shortfall`
