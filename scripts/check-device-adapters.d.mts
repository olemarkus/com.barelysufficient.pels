export function findDeviceAdapterViolations(file: string, source: string): Array<{
  file: string;
  line: number;
  reason: string;
}>;
