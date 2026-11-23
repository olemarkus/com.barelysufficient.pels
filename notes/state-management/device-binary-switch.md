# Selecting a device's on/off control

In Devices, open **Device setup** and select a device
to configure. **On/off control** appears when a generic device exposes an
alternate readable, writable Homey on/off switch. A spa can use its heating
switch for power limiting while retaining its Homey temperature controls.
The selected power source remains an independent setting.

Transport resolves the selected identity from settings before it validates the
capability observation. A rejected or missing selected value withdraws the
binary axis. Other device observations remain available. Selecting **Default**
explicitly returns control to the standard device switch.

Plan inputs, binary intents and pending commands carry an opaque generation for
an explicitly configurable binding. Settings changes and effective binding
changes advance that authority. Transport checks the intent against the current
binding before dispatch and excludes prior-generation transaction echoes from
the new binding's observations. A command is confirmed only by post-dispatch
evidence for the same generation.
