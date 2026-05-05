export const dispatchOpenDeviceDetail = (deviceId: string): void => {
  document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId } }));
};

export const cardActivationProps = (deviceId: string) => ({
  onClick: () => dispatchOpenDeviceDetail(deviceId),
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === ' ') e.preventDefault();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    dispatchOpenDeviceDetail(deviceId);
  },
  onKeyUp: (e: KeyboardEvent) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    dispatchOpenDeviceDetail(deviceId);
  },
});
