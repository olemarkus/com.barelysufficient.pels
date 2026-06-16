// Decoupled re-render trigger for the plan surface. Controllers that write and
// then want the rendered plan refreshed (e.g. the starvation-rescue chip in
// `starvationRescue.ts`) must NOT import the orchestrator (`planRedesign.ts`):
// because a view imports the controller (`PlanDeviceCards` → `starvationRescue`),
// a controller → orchestrator edge would close a
// view → controller → orchestrator → view cycle, which `no-circular` forbids.
// The orchestrator registers its render here at module load; controllers call
// `refreshPlanSurface` against this leaf module (which imports nothing).
let renderPlanSurface: (() => void) | null = null;

export const registerPlanSurfaceRenderer = (render: () => void): void => {
  renderPlanSurface = render;
};

export const refreshPlanSurface = (): void => {
  renderPlanSurface?.();
};
