<p align="center">

<img src="https://github.com/homebridge/branding/blob/latest/logos/homebridge-color-round-stylized.png" width="150">
<img src="https://github.com/Aircoookie/Akemi/blob/master/akemi/007_happy.png" width="150">

</p>

<span align="center">
    
# Homebridge WLED plugin

[![npm](https://img.shields.io/npm/v/homebridge-wled-ws.svg?style=plastic)](https://www.npmjs.com/package/homebridge-wled-ws)
[![npm](https://img.shields.io/npm/dt/homebridge-wled-ws.svg?style=plastic)](https://www.npmjs.com/package/homebridge-wled-ws)
[![npm](https://img.shields.io/npm/v/homebridge-wled-ws/beta?label=beta&style=plastic)](https://www.npmjs.com/package/homebridge-wled-ws?activeTab=versions)
[![GitHub last commit](https://img.shields.io/github/last-commit/smhex/homebridge-wled-ws.svg?style=plastic)](https://github.com/smhex/homebridge-wled-ws)
![GitHub build](https://img.shields.io/github/actions/workflow/status/smhex/homebridge-wled-ws/build_package.yml?style=plastic)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

</span>

This is a Homebridge dynamic platform plugin for controlling LED strips connected to a [WLED](https://github.com/Aircoookie/WLED) controller. It is based on the fantastic [wled-client](https://github.com/ShiftLimits/wled-client) library, which provides access to WLED's JSON API using websockets.


## Description

The plugin adds a Lightbulb to Homekit for every configured WLED controller. The Lightbulb can be switched on and off and it's dimmable. Depending on the LED configuration additional services will be made available (e.g. color selection). For each configured preset a switch is created that can be used in for  automation. Unlike other plugins the preset selection is not implemented as a Homekit Television service.

On Homebridge 2 the controllers can additionally be exposed via [Matter](#matter-homebridge-2-beta), e.g. to use them with Google Home or Amazon Alexa.

## Connection recovery

The plugin manages WebSocket reconnection itself. After 30 seconds without incoming WLED updates, it sends a WebSocket heartbeat. If sending that heartbeat fails, the plugin reconnects automatically. No additional configuration is required.

## Configuration

The plugin supports schema based configuration. All settings can be entered using the plugin's configuration dialog. There is a basic input data validation included, however this needs to be improved in future versions.

Using Homebridge's integrated JSON Editor requires the following configuration entries:

```
{
    "name": "Homebridge-Wled-WS",
    "platform": "wled-ws",
    "controllers": [
        {
            "name": "My WLED Controller",
            "address": "192.168.1.100",
            "presets": "DoorClosed,DoorOpen",
            "showRealTimeModeButton": false,
            "resetRealTimeModeAfterStream": true
        }
    ],
    "enableMatter": false,
    "logging": false
}
```
### Settings

| Setting    | Value                       | Comment                                                                                                                                                                                |
| :----------| :-------------------------- |:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| name       | Name of the WLED controller | This name is used for the acessory in Homekit and for the Homebridge logs                                                                                                              |
| address    | IP address or host name     | Enter the address of the controller - make sure it is the same which is shown as Client IP in the WLED Wifi settings                                                                   |
| presets    | list of presets     | Enter a comma separated list of presets. A switch will be created in Homekit for each preset                                                                                           |
| logging    | True or False               | If enabled (=True) WLED's JSON data will be logged. Leave it disabled if everything works as expected. If you want to file an issue on Github turn it on for later analysis            |
| showRealTimeModeButton | True or False | If enabled (=True) a switch will be created in Homekit to enable/disable real-time mode. This is useful if you sometimes want to disable the real time mode.                           |
| resetRealTimeModeAfterStream | True or False | If disabled (=True) the showRealTimeModeButton Switch controls the state of the realtime mode. If enabled realtime mode always turns back on, after finising a real time mode session. |
| enableMatter | True or False | If enabled (=True) the controllers are additionally exposed as Matter lights. Requires Homebridge 2 with Matter enabled for the bridge, see [Matter](#matter-homebridge-2-beta). Default: False |
| testController | True or False | If enabled (=True) a simulated controller "WLED Test" is added, see [Test controller](#test-controller). Default: False |
| testControllerPort | Port number | Local port of the test controller. Default: 18099 |


> [!IMPORTANT] 
> WLED organizes presets by id. This plugin uses names for configuration. When starting, it checks whether the name exists. If not, an error message is generated. In such a case please check the preset name for typos.

## Matter (Homebridge 2, beta)

Besides HomeKit, the plugin can expose every WLED controller as a Matter device. This makes the controllers available to Matter controllers like Google Home, Amazon Alexa or SmartThings - via the Homebridge Matter bridge, WLED itself does not need Matter support.

> [!NOTE]
> Matter support is new and has not been tested with all Matter controllers yet. Please report issues on Github (with `logging` enabled).

### Requirements

- Homebridge 2 (tested with 2.4) with Matter enabled for the bridge the plugin runs on (main bridge or child bridge). Homebridge 2 requires Node.js 22 or newer.

  On Node.js 20 with Homebridge 1.x the plugin keeps working with HomeKit as before - `enableMatter` is ignored there.
- `enableMatter` enabled in the plugin settings.
- IPv6 and mDNS (multicast) in your network, Matter depends on both. If Homebridge runs in a container (e.g. an LXC container on Proxmox or Docker), make sure the container has an IPv6 address (`ip -6 addr` shows an `fe80::` address) and uses a bridged network, not NAT.

For the main bridge Matter is enabled with a `matter` block in the `bridge` section of the Homebridge `config.json` (or the Homebridge UI):

```
"bridge": {
    "name": "Homebridge",
    ...
    "matter": {
        "port": 5541
    }
}
```

After a restart, Homebridge logs a Matter pairing code and QR code (also shown in the Homebridge UI), which you use to add the bridge in your Matter controller app.

### What is exposed

Each WLED controller becomes **one** Matter light. Its device type follows the LED configuration reported by WLED:

| WLED light capability | Matter device type | Controls |
| :-- | :-- | :-- |
| On/Off only | On/Off Light | on/off |
| White | Dimmable Light | on/off, brightness |
| White with CCT | Color Temperature Light | on/off, brightness, color temperature |
| RGB, RGBW | Extended Color Light | on/off, brightness, color |
| RGBW with CCT | Extended Color Light | on/off, brightness, color, color temperature |

The configured presets and playlists, and the real-time mode switch (if `showRealTimeModeButton` is enabled), are on/off parts of this light. They behave like the HomeKit switches:

- Turning a preset on activates it, the previously active preset is turned off.
- Turning the active preset off turns the light off.
- A playlist turns itself off again right after it was started.
- The real-time mode part is named "Ambilight", like the HomeKit switch.

How the parts are presented depends on the controller app - some show them as separate devices.

If the controller is not reachable, the Matter light is reported as unreachable and commands fail.

### Using HomeKit and Matter together

HomeKit and Matter can be used at the same time - both control the same WLED connection and stay in sync. However, if you add the Homebridge HomeKit bridge **and** the Homebridge Matter bridge to the Apple Home app, every light shows up twice. Typical setups:

- HomeKit only: the default, nothing changes compared to earlier versions.
- HomeKit for Apple Home, Matter for Google Home / Alexa.
- Matter only: disable HomeKit for the bridge (`"hap": { "enabled": false }` in the `bridge` section). To keep other plugins on HomeKit, run this plugin as a child bridge and disable HomeKit only there.

### Sample configurations

The samples show the complete Homebridge `config.json` for the main bridge. Replace the `bridge` values with your own (`username`, `pin` and `port` are created by Homebridge on the first start). The Matter `port` can be any free UDP port.

**HomeKit only** - no `matter` block in `bridge`, `enableMatter` disabled (or omitted):

```
{
    "bridge": {
        "name": "Homebridge",
        "username": "0E:11:22:33:44:55",
        "port": 51826,
        "pin": "031-45-154"
    },
    "platforms": [
        {
            "platform": "wled-ws",
            "name": "wled-ws platform",
            "controllers": [
                {
                    "name": "Living Room",
                    "address": "192.168.1.100",
                    "presets": "DoorClosed,DoorOpen"
                }
            ],
            "enableMatter": false
        }
    ]
}
```

**Matter only** - HomeKit disabled for the bridge, Matter enabled for the bridge and the plugin:

```
{
    "bridge": {
        "name": "Homebridge",
        "username": "0E:11:22:33:44:55",
        "port": 51826,
        "pin": "031-45-154",
        "hap": {
            "enabled": false
        },
        "matter": {
            "port": 5540
        }
    },
    "platforms": [
        {
            "platform": "wled-ws",
            "name": "wled-ws platform",
            "controllers": [
                {
                    "name": "Living Room",
                    "address": "192.168.1.100",
                    "presets": "DoorClosed,DoorOpen"
                }
            ],
            "enableMatter": true
        }
    ]
}
```

**HomeKit and Matter** - both protocols enabled for the bridge, Matter enabled for the plugin:

```
{
    "bridge": {
        "name": "Homebridge",
        "username": "0E:11:22:33:44:55",
        "port": 51826,
        "pin": "031-45-154",
        "matter": {
            "port": 5540
        }
    },
    "platforms": [
        {
            "platform": "wled-ws",
            "name": "wled-ws platform",
            "controllers": [
                {
                    "name": "Living Room",
                    "address": "192.168.1.100",
                    "presets": "DoorClosed,DoorOpen"
                }
            ],
            "enableMatter": true
        }
    ]
}
```

> [!TIP]
> Disabling HomeKit for the main bridge affects all plugins on it. To use Matter only for this plugin while other plugins stay on HomeKit, run it as a child bridge and disable HomeKit only for that child bridge.

### Changes of presets or LED configuration

Matter cannot change the structure of a device while it is published. If the list of presets, the real-time mode switch or the LED configuration (e.g. RGB to RGBW with CCT) changes, the plugin removes the Matter device and adds it again. It keeps the same device id, and the light and unchanged presets keep their Matter endpoint numbers - depending on the controller app, room assignments and automations may still need to be checked afterwards.

### Matter limitations

1. Like HomeKit, only the first (main) segment is controlled.
2. Color changes sent to a light which is turned off are not applied - this is the behavior defined by Matter. Turn the light on first.
3. Continuous dimming (e.g. holding a button of a Matter dimmer switch) is not supported, step and absolute brightness changes are.
4. Color temperature uses the white channel and WLED's CCT value (140-500 mired), same as HomeKit.

## Test controller

For testing the connection between Homebridge and HomeKit / Matter without WLED hardware, the plugin can add a simulated controller. Enable `testController` in the plugin settings (Advanced Settings) and restart the bridge:

```
{
    "platform": "wled-ws",
    "name": "wled-ws platform",
    "controllers": [ ... ],
    "testController": true,
    "logging": true
}
```

The test controller is added like a configured controller:

- Name "WLED Test", an RGB light with on/off, brightness and color.
- Two presets, "Test Red" (red, 50 % brightness) and "Test Blue" (blue, full brightness), exposed as switches (HomeKit) or parts (Matter) like the presets of a real controller.
- It runs inside the plugin and listens on `127.0.0.1:18099` only (change it with `testControllerPort` if the port is in use). The plugin connects to it via WebSocket like to a real controller, so the whole path is tested.
- With `logging` enabled, every command it receives is logged (`Test controller WLED Test received via WebSocket: ...`), together with the plugin's log lines this shows when a change from HomeKit / Matter arrived and when the new state was sent back.
- Its state is not saved, after a restart it is off.

Disable `testController` again to remove the accessory.

## Why using websockets instead of MQTT or HTTP?

Before starting the implementation of this plugin I intended to use WLED's MQTT feature to control my LED strips. While sending data in JSON format to the WLED controller is straightforward, it was difficult for me to parse the answer, which is in XML format. I am not aware of an existing MQTT Homebridge plugin to handle such a device. The HTTP interface is more consistent in that sense, but requires polling to get state updates when the WLED state is modified outside Homekit/Homebridge (e.g. by mobile apps or other smart home automation systems). The websocket approach allows real-time state updates for all connected clients. 

## Limitations

1. WLED supports segments, however the created Homekit accessory only controls the first (main) segment
2. The brightness is set for the whole strip, brightness per segment is ignored


## WLED Compatibility Notes

| Firmware    | Tested                       | Comment |
| :----------| :-------------------------- | :------ |
| 0.13.x  |  ✅ |
| 0.14.1  |  ✅ |
| 0.14.2  | 🔥 | The WLED websocket interface is broken. Using this plugin will most likely trigger a reboot of your controller, hence the connection will fail. |
| 0.14.3  | ✅ |  |
| 0.14.4  | ✅ |  |
| 0.15.0  | ✅ |  |
| 0.15.4  | ✅ |  |

## Thanks to the contributors

- @LeLunZ for adding live mode support
- @smitty078 for adding CCT support and improving WebSocket connection recovery
