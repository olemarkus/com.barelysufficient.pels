# Runtime Layer Boundaries

- `lib/plan` owns desired state, planner reasons, and admission decisions. Planner code decides what state PELS wants, not how that state is applied to a Homey device.
- `lib/device/DeviceTransport` owns observed current state and device-specific actuation transport. Native stepped-load capabilities, stepped-load flow requests, synthetic capability reporting, and Homey write details belong behind this boundary.
- `lib/executor` owns execution of a desired-state transition: compare observed current state with desired state, issue the needed request, and handle pending, retry, wait, skip, and materialization behavior.
- Executor code must not decide whether the planner was allowed to choose a desired state, and it should not branch on planner reasons except through narrow executor-facing adapters while legacy boundaries are being retired.
- Avoid passing broad planner device shapes into executor modules. Prefer small executable action/state types that contain only identity, current observation, desired state, and execution metadata needed for the command path.
- Avoid adding native-vs-flow stepped-load transport branches to planner or executor code. Put those choices in `DeviceTransport` or a `lib/device` helper owned by it. Flow-backed binary control is still transitional in plan/executor code until that boundary is moved separately.
