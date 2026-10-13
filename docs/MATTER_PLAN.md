# Matter Support – Implementation Plan

Status: **PR 1–4 done, README written** — paused, PR 5 (real devices) next · Branch: `feat/matter-support` · Created: 2026-10-13

Goal: expose WLED controllers as Matter devices via the Homebridge 2.x Matter API (`api.matter`),
in addition to the existing HomeKit (HAP) accessories. Work happens in the fork
`StefanRiese/homebridge-wled-ws` (upstream: `smhex/homebridge-wled-ws`).

---

## 0. Where we stopped / how to resume (2026-10-13)

Done and committed on `feat/matter-support` (not pushed): plan, PR 1–4, README Matter section.
Everything is verified with unit tests (114) and against a real Homebridge 2.4 Matter server with a
fake WLED controller — but **not yet with a real WLED controller or a real Matter controller app**.

Next steps, in order:
1. Deploy to the Homebridge LXC container (§5): fill in host/user, check IPv6 in the container,
   `npm version 0.1.0-matter.1 --no-git-tag-version && HB_HOST=<host> scripts/deploy-local.sh`.
2. Enable Matter for the bridge (`bridge.matter`) and `enableMatter` in the plugin config.
3. Pair with Apple Home and/or Google Home and work through the PR 5 checklist below.
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
- [ ] Not done (separate fix): `npm run lint` only lints `eslint.config.mjs`. `eslint src` is clean,
      `test/` has 23 pre-existing `no-explicit-any` errors.

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
- [ ] Deploy to the local Homebridge (§5); confirm HomeKit still works with the real controllers.
- [ ] Pair with Apple Home + Google Home (Alexa if available). Check per app:
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
  (same UUID and endpoint numbers)? How do they present the composed parts? → PR 5. README: pairing both to Apple Home gives
  duplicates; Matter-only via `bridge.hap.enabled: false` (e.g. on a child bridge).
- ~~`ExtendedColorLight` default features – override needed?~~ **Resolved (PR 1):** Homebridge 2.4
  derives ColorControl features from the handlers we provide
  (`determineColorControlFeaturesFromHandlers`): `moveToHueAndSaturationLogic` → HueSaturation,
  `moveToColorLogic` → Xy, `moveToColorTemperatureLogic` → ColorTemperature. On cache restore it
  falls back to the cluster attributes. So: only pass the handlers the strip supports.
- Homebridge 2.x itself requires Node `^22 || ^24 || ^26`; Node 20 users are HB 1.x / HAP-only.
- Keep Node 20 in CI? Proposal: yes (HAP-only there; Matter requires Node ≥ 22.12).

---

## 5. Local test deployment (LXC container)

Homebridge runs in an LXC container on the local network.

### Container details (fill in)

| Item              | Value                         |
|-------------------|-------------------------------|
| Host / IP         | `<HOMEBRIDGE_HOST>`           |
| SSH user          | `<SSH_USER>`                  |
| Install type      | hb-service (`/var/lib/homebridge`)? |
| Node version      | `<node -v>` (Matter needs ≥ 22.12) |
| Homebridge version| `<homebridge -V>` (Matter needs ≥ 2.x) |

Check on the container:
```bash
ls -d /var/lib/homebridge && systemctl status homebridge --no-pager | head -3
node -v && homebridge -V
```

### Prerequisites for Matter in LXC

- **IPv6 must be available.** Matter uses IPv6 + mDNS. Proxmox containers often have IPv6 disabled
  or set to "static" without an address.
  ```bash
  ip -6 addr show scope link     # an fe80:: address on eth0 is required
  ```
  If missing: Proxmox → container → Network → set IPv6 to **SLAAC**, restart container.
- **Bridged networking** (vmbr), no NAT, so mDNS multicast reaches the LAN.
- Matter enabled on the Homebridge bridge (or a child bridge) in the Homebridge UI.
- SSH key login from the dev machine: `ssh <SSH_USER>@<HOMEBRIDGE_HOST> true`.

### Build & install manually

```bash
# on the dev machine
npm version 0.1.0-matter.1 --no-git-tag-version   # pre-release version, see note below
npm run build
npm pack                                           # -> homebridge-wled-ws-0.1.0-matter.1.tgz
scp homebridge-wled-ws-0.1.0-matter.1.tgz <SSH_USER>@<HOMEBRIDGE_HOST>:/tmp/

# on the container (hb-service layout)
sudo -u homebridge npm install --prefix /var/lib/homebridge /tmp/homebridge-wled-ws-0.1.0-matter.1.tgz
sudo hb-service restart
```

Notes:
- **Always use a pre-release version** (`0.1.0-matter.N`). With version 0.0.25 the Homebridge UI
  may offer an "update" to smhex's npm release, which silently overwrites the test build.
- Package and platform name (`wled-ws`) stay unchanged → existing config, HomeKit accessories,
  rooms and automations are kept.
- **Rollback:**
  `sudo -u homebridge npm install --prefix /var/lib/homebridge homebridge-wled-ws@0.0.25 && sudo hb-service restart`
- Logs: `sudo hb-service logs` or the Homebridge UI log view.

### Alternative: install directly from the git branch

Requires the `prepare` script from PR 1 (`dist/` is not committed):
```bash
sudo -u homebridge npm install --prefix /var/lib/homebridge StefanRiese/homebridge-wled-ws#feat/matter-support
sudo hb-service restart
```

### Helper: `scripts/deploy-local.sh`

```bash
npm version 0.1.0-matter.1 --no-git-tag-version
HB_HOST=<HOMEBRIDGE_HOST> HB_USER=root scripts/deploy-local.sh   # HB_USER defaults to root
```
Builds (via `npm pack` → `prepare`), copies the tarball, installs it as the `homebridge` user
(`runuser` when logged in as root, `sudo` otherwise), using `/opt/homebridge/bin/npm` if present,
then runs `hb-service restart`. `HB_PREFIX` overrides `/var/lib/homebridge`.

---

## 6. Release & distribution (decide before PR 5)

The npm package `homebridge-wled-ws` is owned by **smhex**. Options:

1. **Upstream PRs (preferred).** smhex already merged our PRs (#467). Submit PR 1–5 upstream;
   release happens through the existing pipeline.
2. **Own package.** Rename (e.g. `homebridge-wled-matter`), new platform name, `NOTICE` file
   (Apache-2.0 attribution), npm trusted publishing for `release_package.yml`, optional
   Homebridge verification (github.com/homebridge/verified). Users must migrate config and re-pair.
