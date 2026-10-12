/**
 * Where a request to open a device page lands: the top of the page, or a Setup
 * row a deep link names (Setup expanded, the row scrolled into view).
 */
export type DeviceDetailFocus = 'top' | 'start-policy' | 'power-limit';

export type OpenDeviceDetailDetail = {
  deviceId: string;
  focus: DeviceDetailFocus;
};

export const dispatchOpenDeviceDetail = (deviceId: string, focus: DeviceDetailFocus): void => {
  document.dispatchEvent(
    new CustomEvent<OpenDeviceDetailDetail>('open-device-detail', { detail: { deviceId, focus } }),
  );
};

export const cardActivationProps = (deviceId: string) => ({
  onClick: () => dispatchOpenDeviceDetail(deviceId, 'top'),
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === ' ') e.preventDefault();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    dispatchOpenDeviceDetail(deviceId, 'top');
  },
  onKeyUp: (e: KeyboardEvent) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    dispatchOpenDeviceDetail(deviceId, 'top');
  },
});
