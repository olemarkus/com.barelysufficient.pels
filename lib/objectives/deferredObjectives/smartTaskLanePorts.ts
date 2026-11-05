/** Request-boundary ports shared by create, edit and widget lanes. A missing
 * app during startup is an unavailable request, never an invalid candidate. */
export type SmartTaskLanePorts<Host> = {
  host: Host | null;
  clock: { getTimezone(): string };
};
