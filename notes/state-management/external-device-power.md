# External device power

In Devices, open **Add device or change its power source**, choose a Homey
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
eligibility. The source reading maintains normal observation retention while
the socket remains eligible. Removing the socket, reassigning it, changing
its area, or switching it off removes its contribution rather than changing
the load's draw to zero. While its assigned source is unavailable, PELS
blocks device control through that assignment. Removing the assignment
restores the device's own power source.

The setup inventory stays separate from the managed roster and travels through
the existing device settings read. The device's regular observation, planning
and control paths consume the resulting measured power. The socket stays out
of PELS-controlled device actions, with a final write check preventing
an earlier plan from switching it after assignment.
