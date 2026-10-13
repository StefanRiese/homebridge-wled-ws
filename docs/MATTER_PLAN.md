# Matter Support – Implementation Plan

Status: **planned** · Branch: `feat/matter-support` · Created: 2026-10-13

Goal: expose WLED controllers as Matter devices via the Homebridge 2.x Matter API (`api.matter`),
in addition to the existing HomeKit (HAP) accessories. Work happens in the fork
`StefanRiese/homebridge-wled-ws` (upstream: `smhex/homebridge-wled-ws`).

---

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
                          ├─ HapWledAccessory     (current HAP code, slimmed to an adapter)
                          └─ MatterWledAccessory  (new; only if api.isMatterEnabled() && config.enableMatter)
```

### Matter mapping

| WLED capability                 | Matter device type                 | Clusters                                                   |
|---------------------------------|------------------------------------|------------------------------------------------------------|
| OnOff (0)                       | `OnOffLight`                       | OnOff                                                      |
| White (2)                       | `DimmableLight`                    | + LevelControl                                             |
| WCCT (6)                        | `ColorTemperatureLight`            | + ColorControl (`colorTemperatureMireds`)                  |
| RGB (1) / RGBW (3) / RGBWCCT (7) | `ExtendedColorLight`              | + ColorControl hue/sat, `colorMode`, XY, CT (for 7)        |
| Preset / playlist (each)        | `OnOffOutlet`, separate accessory  | OnOff                                                      |
| Live / realtime mode            | `OnOffOutlet`, separate accessory  | OnOff                                                      |

Design decisions:

- **Presets as separate accessories, not `parts`.** UUID = `uuid.generate(address + '-preset-' + id)`
  (live: `address + '-live'`). Preset list changes then only add/remove those accessories and
  never disturb the main light (pairing, room assignment).
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

Matter commands to handle:
`onOff.on/off/toggle`, `levelControl.moveToLevel/moveToLevelWithOnOff`,
`colorControl.moveToHueAndSaturation/moveToHue/moveToSaturation/moveToColor/moveToColorTemperature`.

---

## 3. Implementation steps (one PR each)

### PR 1 – Tooling & compatibility (~½ day)
- [ ] devDependency `homebridge` 1.7 → `^2.4.0` (for `api.matter` types); verify build still works and
      plugin still runs on Homebridge 1.8.
- [ ] Fix `engines.homebridge` → `"^1.8.0 || ^2.0.0"`.
- [ ] Migrate preset switches from `.on('get'/'set')` to `onGet`/`onSet`.
- [ ] Re-enable `npm test` in `.github/workflows/release_package.yml`.
- [ ] Add `"prepare": "npm run build"` (enables install from git branch).
- [ ] Add `scripts/deploy-local.sh` (see §5).
- [ ] Confirm the default ColorControl features of `ExtendedColorLight` in the installed types.

### PR 2 – Extract `WledDevice`, no behavior change (~2–3 days)
- [ ] Move connection, reconnect, heartbeat, state, presets, commands into `src/WledDevice.ts`
      (typed EventEmitter, no `homebridge` imports except `Logger`).
- [ ] Turn `WledWsPlatformAccessory` into `HapWledAccessory` adapter.
- [ ] Move/adapt existing tests (`WledWsStaleClient.test.ts` etc.), add `WledDevice` unit tests.
- [ ] Fix the color temperature unit bug (finding 3).

### PR 3 – Matter main light (~2–3 days)
- [ ] `src/MatterWledAccessory.ts`: registration (device type from cached capability), command
      handlers → `WledDevice`, state push via `updateAccessoryState` with change detection.
- [ ] Conversions + tests in `WledUtils.ts` (incl. XY→RGB).
- [ ] Platform: `configureMatterAccessory`, orphan removal, gate on
      `api.isMatterEnabled() && config.enableMatter`.
- [ ] Re-register when capability differs from cached context.
- [ ] `config.schema.json`: `enableMatter` in "Advanced Settings".
- [ ] Matter API mock in `test/__mocks__`.

### PR 4 – Matter presets, playlists, live mode (~1–2 days)
- [ ] One `OnOffOutlet` accessory per configured preset/playlist; add/remove on preset changes.
- [ ] Live mode outlet when `showRealTimeModeButton` is set.
- [ ] Mirror HAP semantics: exclusive active preset, playlist switches reset to off immediately.

### PR 5 – Real-device testing, docs, release (~2–3 days)
- [ ] Test on local Homebridge (§5) with Apple Home + Google Home (Alexa if available).
- [ ] Matrix: each strip type available, WLED reboot, Homebridge restart (cache restore), preset
      list change, controller removed from config.
- [ ] Log which color commands each controller actually sends.
- [ ] README: Matter section (enabling, duplicates warning, supported features), CHANGELOG.
- [ ] Release `0.1.0` beta (see §6).

**Total estimate: ~1.5–2 weeks.**

---

## 4. Open questions

- Which ColorControl commands do Apple Home / Google Home send (hue/sat vs. XY)? → verify in PR 5.
- `ExtendedColorLight` default features for RGB strips without CCT – override needed? → PR 1.
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

### Planned helper: `scripts/deploy-local.sh` (PR 1)

```bash
#!/usr/bin/env bash
# Usage: HB_HOST=<host> HB_USER=<user> scripts/deploy-local.sh
set -euo pipefail
: "${HB_HOST:?set HB_HOST}"; : "${HB_USER:?set HB_USER}"
HB_PREFIX="${HB_PREFIX:-/var/lib/homebridge}"

npm run build
TGZ=$(npm pack --silent | tail -1)
scp "$TGZ" "$HB_USER@$HB_HOST:/tmp/$TGZ"
ssh -t "$HB_USER@$HB_HOST" \
  "sudo -u homebridge npm install --prefix '$HB_PREFIX' '/tmp/$TGZ' && sudo hb-service restart && rm '/tmp/$TGZ'"
rm "$TGZ"
```

---

## 6. Release & distribution (decide before PR 5)

The npm package `homebridge-wled-ws` is owned by **smhex**. Options:

1. **Upstream PRs (preferred).** smhex already merged our PRs (#467). Submit PR 1–5 upstream;
   release happens through the existing pipeline.
2. **Own package.** Rename (e.g. `homebridge-wled-matter`), new platform name, `NOTICE` file
   (Apache-2.0 attribution), npm trusted publishing for `release_package.yml`, optional
   Homebridge verification (github.com/homebridge/verified). Users must migrate config and re-pair.
