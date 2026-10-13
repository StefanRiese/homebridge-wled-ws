# Matter Support – Implementation Plan

Status: **paused on 2026-10-13 during PR 5** (real-device tests) — Matter is skipped for now, the branch is kept · Branch: `feat/matter-support` · Created: 2026-10-13

Goal: expose WLED controllers as Matter devices via the Homebridge 2.x Matter API (`api.matter`),
in addition to the existing HomeKit (HAP) accessories. Work happens in the fork
`StefanRiese/homebridge-wled-ws` (upstream: `smhex/homebridge-wled-ws`).

---

## 0. Where we stopped / how to resume (2026-10-13)

**Paused.** After the real-device tests the Matter implementation is skipped for now; the branch
`feat/matter-support` is kept (committed and pushed) to continue later. Reason: over Matter, Apple
Home shows state changes of the preset parts much later than HomeKit (20–30 s vs. 1–2 s) although
the plugin hands them to Homebridge's Matter server within the same second, and all part buttons are
labelled with the device name. Results in the PR 5 checklist (§3).

State of the Homebridge instance when pausing:
- Plugin: **0.0.25 from npm** (reinstalled via the Homebridge UI on 2026-10-13 17:36); the test
  build tarball is still in `/var/lib/homebridge/local-plugins/`.
- WLED child bridge: `_bridge.matter` = `{ "port": 5541, "enabled": false }` (Matter server off,
  pairing data in `/var/lib/homebridge/matter/0ECF014DFE63` kept). The Matter bridge is still
  paired in Apple Home and shows "No Response" until it is removed there or Matter is re-enabled.
- Config still contains test settings that 0.0.25 ignores: `enableMatter: true`,
  `testController: true`, `logging: true`, Wled_Cube `presets: "Colortwinkles,Solid"` and
  `showRealTimeModeButton: true`. Backups: `config.json.bak-20261013-*` on the host.

To resume: decide on presets as parts vs. separate Matter devices (and whether the delay also
affects the light itself, see the open test in §3), deploy the branch with
`npm version 0.1.0-matter.5 --no-git-tag-version && HB_HOST=homebridge scripts/deploy-local.sh`,
set `"enabled": true` in `_bridge.matter` and run `hb-service restart`.

History: branch is pushed to the fork and up to date with `main`: the upstream fixes #468–#470 were merged
and ported into `WledDevice` / the HomeKit accessory (124 tests, end-to-end checks unchanged).

Done and committed on `feat/matter-support`: plan, PR 1–4, README Matter section, test controller.
Everything is verified with unit tests (114) and against a real Homebridge 2.4 Matter server with a
fake WLED controller — but **not yet with a real WLED controller or a real Matter controller app**.

Next steps, in order:
1. ✅ 2026-10-13: `0.1.0-matter.1` deployed to the Homebridge LXC container (§5) with
   `HB_HOST=homebridge scripts/deploy-local.sh`, `enableMatter` still off. The WLED child bridge
   started cleanly; the startup log matches 0.0.25 (3 controllers connected, Wled_Rainbow lc=3,
   Wled_Cube and Wled_Keno_Uhr lc=1; WLED 16.0.1 and 0.14.0-b1). Checked in the Home app: on/off,
   brightness and color work as expected on all three controllers.
2. ✅ 2026-10-13: Matter enabled on the WLED child bridge (`_bridge.matter.port` 5541) and
   `enableMatter: true`, then `hb-service restart`. All three lights registered as Extended Color
   Lights (HueSaturation + Xy), node online. After a restart of the child bridge the cached Matter
   devices were reused with the same UUIDs, no re-registration.
3. Pair with Apple Home and/or Google Home and work through the PR 5 checklist below.
   Apple Home paired on 2026-10-13: on/off, brightness, color OK. Next: `logging` on to see the
   color commands, a preset on one controller to test parts, HomeKit ↔ Matter in parallel.
   2026-10-13: Wled_Cube set up as test controller (`presets: "Colortwinkles"`,
   `showRealTimeModeButton: true`, platform `logging: true`; backup `config.json.bak-20261013-152946`).
4. Fix what comes up, then CHANGELOG + release decision (§6).

Test harness used so far (lives in the session scratchpad, **not in the repo** — rebuild if needed):
`fake-wled.js` (HTTP + websocket WLED double, `LC=<capability>`), `scenario.sh` (scripted HomeKit
run with baseline diff), `run-matter.sh` and `matter-commands.js` (real Homebridge 2.4 Matter
server, commands via the `matterAccessoryControl` IPC message the Homebridge UI uses).
Consider adding a cleaned-up version under `test/e2e/` in PR 5.

## 1. Background

### Homebridge Matter API (Homebridge ≥ 2.x, verified against 2.4.0 types)

- `api.matter` is only defined when Matter is enabled on the bridge — check `api.isMatterEnabled()`
  or use optional chaining. On Homebridge 1.x / Node 20 it is simply `undefined`.
- `api.matter.registerPlatformAccessories(pluginId, platformName, accessories[])` – async.
- `api.matter.unregisterPlatformAccessories(...)` – only `uuid` required.
- `api.matter.updatePlatformAccessories(accessories[])` – metadata only (name, model, …).
- `api.matter.updateAccessoryState(uuid, cluster, attributes, partId?)` – push external state changes.
  **Do not call inside command handlers** (state auto-updates after a handler completes).
- `api.matter.getAccessoryState(uuid, cluster, partId?)`.
- `DynamicPlatformPlugin.configureMatterAccessory(accessory)` – cache restore, Matter equivalent of
  `configureAccessory`.
- `MatterAccessory`: `UUID`, `displayName`, `serialNumber`, `manufacturer`, `model`,
  `firmwareRevision?`, `deviceType`, `context`, `clusters?` (initial state), `handlers?`
  (per cluster, per command), `getState?`, `parts?` (composed child endpoints).
- Relevant device types: `OnOffLight`, `DimmableLight`, `ColorTemperatureLight`,
  `ExtendedColorLight`, `OnOffOutlet`.
- Relevant clusters: `OnOff`, `LevelControl`, `ColorControl`, `BridgedDeviceBasicInformation`.

Docs: <https://developers.homebridge.io/homebridge/interfaces/MatterAPI.html>,
<https://developers.homebridge.io/homebridge/interfaces/MatterAccessory.html>

### Findings in the current code

1. **Device type must be known at registration time, but capabilities are only known after
   connecting.** `lightCapabilities` arrives in `updateAccessoryInformation()` after `update:info`.
   → Persist the capability in the Matter accessory `context`; register from the cached value on
   startup; re-register if WLED reports a different capability.
2. **HAP calls are interwoven with all WLED logic** (`onStateReceived()`, `onPresetsReceived()` in
   `src/WledWsPlatformAccessory.ts`). → Extract a protocol-neutral `WledDevice` first.
3. **Bug:** `setColorTemperature()` stores a WLED CCT value (0–255) in `ledState.ColorTemperature`,
   while `getColorTemperature()` returns it to HomeKit as mired and `onStateReceived()` stores mired.
   Mixed units in one field. Fix during the refactor.
4. Preset switches still use deprecated `.on('get' | 'set')` callbacks → migrate to `onGet`/`onSet`.
5. `engines.homebridge` is `"^1.8.0|| ^2.0.0-beta.0"` (typo / beta reference).

---

## 2. Target architecture

```
WledWsHomebridgePlatform ─┬─ WledDevice (one per controller, protocol-neutral)
                          │    websocket, reconnect/heartbeat, state, presets, commands
                          │    events: connected / disconnected / state / info / presets
                          ├─ WledWsPlatformAccessory (HAP adapter; class name kept to keep the upstream diff readable)
                          └─ MatterWledAccessory  (new; only if api.isMatterEnabled() && config.enableMatter)
```

### Matter mapping

| WLED capability                 | Matter device type                 | Clusters                                                   |
|---------------------------------|------------------------------------|------------------------------------------------------------|
| OnOff (0)                       | `OnOffLight`                       | OnOff                                                      |
| White (2)                       | `DimmableLight`                    | + LevelControl                                             |
| WCCT (6)                        | `ColorTemperatureLight`            | + ColorControl (`colorTemperatureMireds`)                  |
| RGB (1) / RGBW (3) / RGBWCCT (7) | `ExtendedColorLight`              | + ColorControl hue/sat, `colorMode`, XY, CT (for 7)        |
| Preset / playlist (each)        | `OnOffOutlet` part of the light    | OnOff                                                      |
| Live / realtime mode            | `OnOffOutlet` part of the light    | OnOff                                                      |

Design decisions:

- **Presets as `parts` of one accessory per controller** (decided 2026-10-13, like the HomeKit
  grouping). Part ids `preset-<id>` and `live`. Matter can't change the structure of a registered
  endpoint, so a changed preset list re-registers the accessory.
- **One stable UUID per controller** (`uuid.generate('matter:' + address)`). On a structure change
  matter.js reuses the endpoint numbers of the light and of unchanged parts (verified), which gives
  controllers the best chance to keep room/automations — to be confirmed with real controllers.
- **`OnOffOutlet`, not `OnOffSwitch`.** A Matter `OnOffSwitch` is a *controller* device and is not
  shown as a toggle in Apple Home.
- **Reachability:** on disconnect set `BridgedDeviceBasicInformation.reachable = false`
  (Matter has no HAP-style "No Response" error).
- **Opt-in:** new config option `enableMatter` (default `false`). Both HAP and Matter paired to
  Apple Home = duplicate devices.

### Value conversions (add to `WledUtils.ts`, unit-tested)

| Quantity    | WLED          | HomeKit   | Matter                     |
|-------------|---------------|-----------|----------------------------|
| Brightness  | 0–255         | 0–100 %   | `currentLevel` 1–254       |
| Hue         | RGB           | 0–360°    | `currentHue` 0–254         |
| Saturation  | RGB           | 0–100 %   | `currentSaturation` 0–254  |
| Color temp  | CCT 0–255     | mired     | `colorTemperatureMireds`   |
| XY color    | RGB           | –         | `currentX/currentY` 0–65279 |

Matter handler names (Homebridge 2.4 `handlers` keys):
- `onOff`: `on`, `off`, `toggle`
- `levelControl`: `moveToLevel`, `moveToLevelWithOnOff`, `move`, `step`, `stop`
- `colorControl`: `moveToHueAndSaturationLogic`, `moveToHueLogic`, `moveToSaturationLogic`,
  `moveToColorLogic` (XY), `moveToColorTemperatureLogic`, `stopAllColorMovement`

---

## 3. Implementation steps (one PR each)

### PR 1 – Tooling & compatibility (~½ day) ✅
- [x] devDependency `homebridge` 1.7 → `^2.4.0` (for `api.matter` types). Needed `skipLibCheck`
      in `tsconfig.json` (matter.js typings need newer libs). `target` deliberately kept at ES2018:
      ES2022 class-field semantics would break `Service = this.api.hap.Service` in the platform.
- [x] Fix `engines.homebridge` → `"^1.8.0 || ^2.0.0"`.
- [x] Migrate preset switches from `.on('get'/'set')` to `onGet`/`onSet`. Also fixes an unhandled
      promise rejection: async `setPreset` threw `HapStatusError` inside a callback-style handler.
      Tests added.
- [x] Re-enable `npm test` in `.github/workflows/release_package.yml`.
- [x] Add `"prepare": "npm run build"` (enables install from git branch).
- [x] Add `scripts/deploy-local.sh` (see §5).
- [x] Default ColorControl features of `ExtendedColorLight`: **no override needed** (see §4).
- [x] `.npmignore`: exclude `test/`, `docs/`, `scripts/` and dev configs from the npm package.
- [x] Lint script fixed: `npm run lint` linted only `eslint.config.mjs`. Now `eslint . --max-warnings=0`
      over `src/` and `test/` (same style rules for both); `no-explicit-any` and `no-require-imports`
      are allowed in tests (test double casts, hoisted `jest.mock()` factories).

### PR 2 – Extract `WledDevice`, no behavior change (~2–3 days) ✅
- [x] `src/WledDevice.ts`: connection, reconnect, heartbeat, info/capability, preset list and
      preset/playlist activity tracking, commands. Typed `EventEmitter` with events `connected`,
      `disconnected`, `state`, `info` (once), `presets`, `presetChanged`. Only `Logger` from homebridge.
- [x] `WledWsPlatformAccessory` is now the HAP adapter (class name kept on purpose). It keeps its
      own state in HomeKit units and maps presets to services via `presetServices` by preset id.
- [x] `WledControllerPreset` (held a HAP `Service`) replaced by protocol-neutral `WledPreset`.
- [x] Platform creates one `WledDevice` per controller (`deviceMap`), attaches the HAP adapter,
      then connects; shutdown disconnects the devices.
- [x] Tests adapted; new `test/WledDevice.test.ts` (connection, presets, playlists, info, live).
      40 tests total.
- [x] Fixed color temperature unit bug (finding 3); test verified to fail on the old code.
- [x] Side fixes: color temperature is only pushed/logged when it changed (was logged at info
      level on every state update); preset `on` state survives a preset list refresh (the list
      was appended to instead of replaced on every reconnect).
- [x] Verified with an end-to-end replay (fake WLED + real Homebridge 1.8.5 and 2.4.0, RGB and
      RGBWCCT strips): identical WLED traffic, identical final HomeKit state, identical plugin log
      except the removed duplicate color temperature lines.

### PR 3 – Matter main light (~2–3 days) ✅
- [x] `src/WledMatterAccessory.ts`: device type per capability, command handlers → `WledDevice`,
      state push via `updateAccessoryState` with change detection and rounding tolerance,
      reachability via `bridgedDeviceBasicInformation.reachable`.
- [x] Conversions + tests in `WledUtils.ts` (level, Matter hue/sat, RGB↔XY).
- [x] Platform: `configureMatterAccessory`, cached accessory matched by controller address,
      orphan removal (also all of them when `enableMatter` is switched off), gate on
      `config.enableMatter && api.isMatterEnabled?.()` (safe on Homebridge 1.x).
- [x] `config.schema.json`: `enableMatter` in "Advanced Settings" (default off).
- [x] Tests with a Matter API double (`test/helpers/fakeMatter.ts`), 99 tests total.
- [x] Verified against a real Homebridge 2.4 Matter server (fake WLED, commands via the
      Homebridge UI IPC channel): all strip types register, restart restores the endpoint,
      capability changes re-register, all commands reach WLED, offline commands fail cleanly.

Findings from the real Matter stack (not visible with mocks):
- Bridged (un)registrations are fire-and-forget: the API promises resolve before Homebridge
  applied them. → Wait for registration via `getAccessoryState`; the UUID contains the light
  capability (`matter:<address>:<lc>`) so a capability change never races an unregister.
- With the ColorTemperature feature, Matter requires `coupleColorTempToLevelMinMireds`;
  without it every CCT strip failed to register.
- matter.js calls handlers internally (`stopAllColorMovement`, hue + saturation steps of
  `moveToHueAndSaturation`). A missing handler on such a call is an unhandled error that **stops
  Homebridge**. → All handlers of present clusters are provided; internal ones never throw;
  identical color commands within 1 s are sent to WLED only once.
- Color commands on a light that is off are not executed by matter.js (Matter spec, ExecuteIfOff).
- `levelControl.move` (continuous dimming) has no WLED equivalent: accepted as no-op.

### PR 4 – Matter presets, playlists, live mode (~1–2 days) ✅
- [x] Presets/playlists and the live mode switch (`showRealTimeModeButton`) as `OnOffOutlet` parts
      of the light; names like the HomeKit switches (preset name, "Ambilight").
- [x] HAP semantics via `WledDevice`: exclusive active preset, playlists reset to off, preset off
      turns the light off. Kept the HAP behavior that the active preset stays on when the light
      is turned off.
- [x] Structure (capability, presets, live) stored in the cache context. A cached accessory is
      registered once the controller reported its structure (fallback after 15 s if offline);
      the first registration waits up to 5 s for the presets.
- [x] Structure change: unregister → wait until gone + 0.5 s → register, repeated while Homebridge
      drops it because the UUID is not free yet. Unregister needs `deviceType` (Homebridge reads it).
- [x] Verified on a real Homebridge 2.4 Matter server: composed endpoint (light #2, parts #3–#5),
      restart reattaches, removing/re-adding a preset keeps all endpoint numbers, strip type change
      rebuilds the color features, part commands reach WLED. 114 unit tests.

### PR 5 – Real-device testing, docs, release (~2–3 days) — in progress
- [x] README: Matter section (requirements incl. IPv6/LXC, exposed device types, presets as
      parts, HomeKit + Matter together, structure changes, limitations); `enableMatter` in the
      settings table and config example.
- [x] README: sample `config.json` for HomeKit only, Matter only (`bridge.hap.enabled: false`) and
      HomeKit + Matter — each verified on Homebridge 2.4 (bridge published / Matter server / plugin
      Matter accessory as expected, no errors).
- [x] Deploy to the local Homebridge (§5); confirm HomeKit still works with the real controllers.
      (2026-10-13, `0.1.0-matter.1`, 3 controllers: on/off, brightness, color OK)
- [ ] Pair with Apple Home + Google Home (Alexa if available). Check per app:
  - Apple Home (2026-10-13): paired via Matter (2 fabrics added, as usual for Apple); on/off,
    brightness and color work on all three lights (2× RGB lc=1, 1× RGBW lc=3). Color command type
    not checked yet (`logging` off). No presets/live configured, so no parts tested yet.
  - Apple Home, Wled_Cube with preset + live parts (2026-10-13): the structure change re-registered
    the light before the node went online; the next restarts restored it from the cache (2 parts,
    no re-registration). Over Matter: on/off, level, live part on/off and preset on/off work.
    **Apple Home sends hue/saturation** (`moveToHueAndSaturation`), not xy. Note: Apple Home shows
    the HomeKit and the Matter accessory side by side with the same name — check the tile's settings
    (Matter section) to know which one is tested.
  - `0.1.0-matter.2`: preset commands from Matter are logged (`Matter: set controller … preset`),
    the real-time reset log line shows the controller name.
  - **Problems with parts in Apple Home** (2026-10-13, Wled_Cube after adding preset "Solid", i.e.
    a second structure change of the paired light):
    - All part buttons are labelled with the device name ("WledCube"), not "Colortwinkles" /
      "Solid" / "Ambilight". Homebridge only gives parts a Descriptor TagList label; Apple Home
      ignores it. homebridge-shelly-matter documents the same: grouped channels always show the
      device name.
    - Part states set by the plugin are not shown: switching Solid on turns Colortwinkles off in
      WLED and in Homebridge's Matter state (verified in the matter.js storage on the host), but
      Apple Home keeps both buttons on, also after closing and reopening the tile.
    - Possible cause: homebridge-shelly-matter notes that "Apple Home mishandles devices that
      reappear with the same identity but a different structure" (our stable UUID approach).
    - Commands from the part buttons work.
    - Update: the part states do arrive in Apple Home, but late (about 20–30 s, sometimes much
      faster). `0.1.0-matter.3` logs when a state is handed to Matter
      (`Matter: updated part …` / `Matter: updated <cluster> …`) to measure where the delay is.
  - Test controller (`testController: true`, 2026-10-13): simulated WLED controller "WLED Test"
    inside the plugin (`src/WledSimulator.ts`, HTTP + WebSocket on `127.0.0.1:18099`), RGB light
    with the presets "Test Red" / "Test Blue". For testing HomeKit / Matter without hardware;
    logs every command it receives.
  - Timing with the test controller (2026-10-13): the plugin hands every change to HomeKit and
    Matter within the same second (command → simulator → echo → `Matter: updated …`), including
    switching the previous preset off. In Apple Home the other preset turns off within 1–2 s on
    the HomeKit tile, but noticeably later on the Matter tile (Wled_Cube: 20–30 s, sometimes
    faster). → The delay is between Homebridge's Matter server and Apple Home, not in the plugin.
    Still open: are changes of the light itself (on/off, brightness) also slow over Matter, or only
    the parts?
  - Side effect seen: switching off a preset that is not active turns the light off (also on
    HomeKit, same as before). Possible change: only the active preset turns the light off.
  - [ ] light + preset/playlist/live parts: how are they presented?
  - [ ] on/off, brightness, color, color temperature work; which color commands are sent
        (enable `logging`, look for `Matter: set controller ...` lines: hue/saturation vs. xy)
  - [ ] preset/playlist/live parts work, exclusive preset, playlist resets
  - [ ] state changes from the WLED app show up in the Matter app
- [ ] HomeKit and Matter in parallel: a HomeKit change shows up in the Matter app and vice versa.
- [ ] Structure change (remove a preset from the config, restart): does the app keep the light's
      room and automations? (same UUID, endpoint numbers are kept — verified)
- [ ] Matrix: each strip type available, WLED reboot (reachability), Homebridge restart (cache
      restore), controller removed from config, `enableMatter` switched off (accessory removed).
- [ ] Update README with the results (tested controllers, presentation of parts), CHANGELOG.
- [ ] Release `0.1.0` beta (see §6).

**Total estimate: ~1.5–2 weeks.**

---

## 4. Open questions

- Which ColorControl commands do Apple Home / Google Home send (hue/sat vs. XY)? → verify in PR 5.
- HAP and Matter in parallel: both adapters share one `WledDevice`; verify a HomeKit change shows
  up on the Matter side in the same run → PR 5.
- Do Apple Home / Google Home keep room and automations of the light after a structure change
  (same UUID and endpoint numbers)? How do they present the composed parts? → PR 5.
- ~~README: HomeKit + Matter together~~ **Done:** pairing both to Apple Home gives duplicates;
  Matter only via `bridge.hap.enabled: false` (e.g. on a child bridge) — see README sample
  configurations.
- ~~`ExtendedColorLight` default features – override needed?~~ **Resolved (PR 1):** Homebridge 2.4
  derives ColorControl features from the handlers we provide
  (`determineColorControlFeaturesFromHandlers`): `moveToHueAndSaturationLogic` → HueSaturation,
  `moveToColorLogic` → Xy, `moveToColorTemperatureLogic` → ColorTemperature. On cache restore it
  falls back to the cluster attributes. So: only pass the handlers the strip supports.
- Homebridge 2.x itself requires Node `^22 || ^24 || ^26`; Node 20 users are HB 1.x / HAP-only.
- ~~Keep Node 20?~~ **Decided: yes.** Node 20 = Homebridge 1.x, HomeKit only (`enableMatter` is
  ignored). Verified with Node 20.20.2: `npm ci` (only EBADENGINE warnings from the Homebridge 2.4
  dev dependency), lint, build and all tests pass; HomeKit scenario on Homebridge 1.8.5 identical to
  the baseline, also with `enableMatter: true`. CI keeps the Node 20 build.

---

## 5. Local test deployment (LXC container)

Homebridge runs in an LXC container on the local network.

### Container details (checked 2026-10-13)

| Item              | Value                         |
|-------------------|-------------------------------|
| Host              | Proxmox LXC container 106; SSH alias `homebridge` in `~/.ssh/config` of the dev machine (IP, user and key in the private `StefanRiese/MyHomebridge` notes) |
| SSH user          | `root` (key login)            |
| Install type      | hb-service: service `homebridge`, user `homebridge`, data in `/var/lib/homebridge` |
| Node version      | v24.21.0 in `/opt/homebridge/bin` (not on root's `PATH`) |
| Homebridge version| 2.4.0 (`/var/lib/homebridge/node_modules/homebridge`), UI 5.29.0 |
| Plugin            | `homebridge-wled-ws` 0.0.25 on the child bridge "Homebridge WLED", 3 controllers |
| IPv6              | ✅ `fe80::` link-local and an `fd90:…` ULA address on `eth0` |
| Matter            | not enabled yet on any bridge |

Every plugin runs on its own child bridge, so a test deploy restarts only the WLED child bridge.

### Prerequisites for Matter in LXC

- **IPv6 must be available.** Matter uses IPv6 + mDNS. Proxmox containers often have IPv6 disabled
  or set to "static" without an address.
  ```bash
  ip -6 addr show scope link     # an fe80:: address on eth0 is required
  ```
  If missing: Proxmox → container → Network → set IPv6 to **SLAAC**, restart container.
- **Bridged networking** (vmbr), no NAT, so mDNS multicast reaches the LAN.
- Matter enabled on the Homebridge bridge (or a child bridge) in the Homebridge UI.
- SSH key login from the dev machine: `ssh homebridge true`.

### Helper: `scripts/deploy-local.sh`

```bash
npm version 0.1.0-matter.1 --no-git-tag-version   # pre-release version, see notes below
HB_HOST=homebridge scripts/deploy-local.sh
```
Builds (via `npm pack` → `prepare`), copies the tarball to `/var/lib/homebridge/local-plugins/`
(kept there: npm records the path in `/var/lib/homebridge/package.json`, and later plugin installs
from the UI fail if it is missing; older tarballs of the plugin are removed), installs it as the
`homebridge` user with `/opt/homebridge/bin` on the `PATH`, then restarts only the plugin's child
bridge (SIGTERM → clean shutdown, Homebridge starts it again).
- `HB_RESTART=all` runs `hb-service restart` instead (plugin on the main bridge), `none` skips it.
- The child bridge restart keeps the config the bridge was started with. After editing
  `config.json`, restart the bridge from the Homebridge UI (it rereads the config) or run
  `hb-service restart`; changes to `_bridge` (e.g. `matter`) always need `hb-service restart`.
- `HB_USER` overrides the ssh user, `HB_PREFIX` overrides `/var/lib/homebridge`.

Notes:
- **Always use a pre-release version** (`0.1.0-matter.N`). With version 0.0.25 the Homebridge UI
  may offer an "update" to smhex's npm release, which silently overwrites the test build.
- Package and platform name (`wled-ws`) stay unchanged → existing config, HomeKit accessories,
  rooms and automations are kept.
- **Rollback** (on the host, then restart the WLED child bridge in the UI):
  `cd /var/lib/homebridge && runuser -u homebridge -- env PATH=/opt/homebridge/bin:$PATH npm install homebridge-wled-ws@0.0.25`
- Logs: Homebridge UI log view or `/var/lib/homebridge/homebridge.log`.

---

## 6. Release & distribution (decide before PR 5)

The npm package `homebridge-wled-ws` is owned by **smhex**. Options:

1. **Upstream PRs (preferred).** smhex already merged our PRs (#467). Submit PR 1–5 upstream;
   release happens through the existing pipeline.
2. **Own package.** Rename (e.g. `homebridge-wled-matter`), new platform name, `NOTICE` file
   (Apache-2.0 attribution), npm trusted publishing for `release_package.yml`, optional
   Homebridge verification (github.com/homebridge/verified). Users must migrate config and re-pair.
