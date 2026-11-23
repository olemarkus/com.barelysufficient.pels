# External device power

In Devices, open **Device setup**, choose a Homey
device, and select either **This device** or an unmanaged metering socket.
PELS can admit an explicitly added device through its validated generic
temperature and on/off controls. Its Homey device class and specialised
control roles are preserved.

A socket provides live watts to one device in its meter area. The socket
stays unmanaged while assigned. PELS attributes the socket's accepted reading
and its observation time to the controlled device. The household meter still
measures the whole home. Homey Energy continues to account for devices
according to its own settings.

The device owner validates assignment settings and current physical-device
eligibility. The SDK read pipeline projects the socket's `measure_power`
capability onto the controlled device and resolves it through the same path
as a native power reading. If the socket becomes unavailable or the
assignment is no longer eligible, the projected capability disappears and
the device's remaining capabilities follow their normal control rules.
An off report withdraws earlier watts. A fresh zero reported after the
switch is an observation. Removing the assignment restores the device's
own power source.

The setup inventory stays separate from the managed roster and travels through
the existing device settings read. The device's regular observation, planning
and control paths consume the resulting measured power. The socket stays out
of PELS-controlled device actions, with a final write check preventing
an earlier plan from switching it after assignment.
