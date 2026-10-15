# Segment Support – Implementation Plan

Status: **plan agreed, not started** · Branch: `feat/segment-support` · Created: 2026-10-15 ·
Issue: [smhex/homebridge-wled-ws#318](https://github.com/smhex/homebridge-wled-ws/issues/318)

Goal: let users control individual WLED segments from HomeKit, each as its own light with on/off,
brightness and color. Work happens in the fork `StefanRiese/homebridge-wled-ws` and goes upstream
PR by PR (upstream: `smhex/homebridge-wled-ws`).

---

## 0. Where we are / next step

Nothing implemented yet. Before any code:

1. ✅ 2026-10-15: all decisions in §3 agreed – D1 separate accessory per segment, D2 list of
   segment names, D3 segment brightness, D4 segment On also turns the master on.
2. Ask on #318 whether the maintainer wants segment support upstream and is fine with the
   `WledDevice` refactor (PR 1). The maintainer answered in 2025-09 that segments were never
   considered and suggested one preset per segment as a workaround, so this is a sizeable feature
   in a repo we don't own.
3. Wait until the open PRs #471–#475 are merged (or rebase on them). PR 1 moves most of
   `WledWsPlatformAccessory.ts` and would conflict with all of them.

## 1. The request (#318)

The reporter has three controllers in a kitchen, each with several segments. One segment should
light up in a different color and brightness on motion, then go back to how it was. Today the
plugin only exposes the whole controller: color goes to segment 0, brightness is global. The README
lists both as known limitations ("Limitations" 1 and 2).

The issue also asks to control segments of **different controllers together**. That needs no plugin
code: once segments are separate HomeKit lights, HomeKit groups, scenes and automations combine them
across controllers. The plan only documents this in the README.

**In scope:** a HomeKit light per configured segment (on/off, brightness, color, color temperature
where the segment supports it), state updates from WLED, cleanup of removed segments, docs, tests.

**Out of scope:** creating, deleting or resizing segments from HomeKit; per-segment effects or
palettes; per-segment presets (WLED presets are global); "resume previous state" logic (HomeKit
scenes and automations already do this); Matter (see §3, D7).

## 2. Background

### WLED segments

Facts from wled-client 0.22.1 (verified in `dist/node/wled-client.cjs`):

- State: `state.segments[]` with `id`, `name` (WLED `n`), `on`, `brightness` (`bri`), `colors`
  (`col`), `cct`, `start`, `stop`, …; the master values are `state.on` / `state.brightness`.
- Capabilities per segment: `info.leds.segmentLightCapabilities` (WLED `seglc`), one entry per
  segment, same encoding as `lightCapabilities` (0 OnOff, 1 RGB, 2 White, 3 RGBW, 6 WCCT, 7 RGBWCCT).
- Commands accept a segment: `turnOn({ segmentId })`, `turnOff({ segmentId })`,
  `setBrightness(v, { segmentId })`, `setColor(c, { segmentId })`, `setCCT(v, { segmentId })`.
  They send `{ seg: [{ id, … }] }`.
- Pitfall: `getSegment(id)` (used by `toggle()`) indexes the **array**, not the segment id. We don't
  use `toggle()`, and we always look segments up by `id`/`name` ourselves.
- Existing behavior to keep in mind: without `segmentId`, `setColor` and `setCCT` go to segment 0
  (`segmentId || 0`), while `turnOn` / `setBrightness` act on the master. That is why the
  controller light only colors the first segment today.

WLED behavior (from WLED's JSON API docs, **to verify on a real controller in PR 5**):

- Segment brightness is applied on top of the master brightness (output ≈ master × segment).
- Master `on: false` turns the whole strip dark, whatever the segment `on` states are.
- Segment ids don't have to be contiguous (e.g. 0 and 2 after deleting 1). Segment names are
  optional; the WLED UI shows unnamed segments as "Segment &lt;id&gt;".
- Applying a preset can replace the whole segment layout (ids, names, number of segments).

### Plugin today

`WledWsPlatformAccessory` owns everything for one controller: the WLEDClient connection,
reconnect/heartbeat, state tracking and the HAP services. The platform creates one accessory per
controller. A segment light that is its own accessory needs the controller's connection, so the
connection has to be shared (WLED also only allows a few websocket clients, so no second connection
per segment).

The Matter branch (`feat/matter-support`, paused) already extracted this into `src/WledDevice.ts`
(PR 2 there, verified with an end-to-end replay). PR 1 here ports that refactor to `main` without
the Matter parts.

## 3. Decisions

### D1 – HomeKit shape: one accessory per segment ✅ *decided 2026-10-15: option A*

| Option | Pro | Con |
|---|---|---|
| **A. Separate accessory per segment** (recommended) | own tile and **own room** (the kitchen use case: segments are in different places); clean automations | needs a shared connection (PR 1 refactor); more accessories on the bridge |
| B. Extra `Lightbulb` service on the controller accessory | no refactor, fits the current code | one accessory = one room; Home groups the services into one tile (can be shown as separate tiles, but room assignment stays per accessory – to verify) |

**Decided: A.** B is cheaper but doesn't solve the reporter's case if the segments are in
different rooms. A needs the shared connection, so PR 1 (`WledDevice`) is required.

### D2 – Identifying segments: by name, like presets ✅ *decided 2026-10-15: list of names*

New per-controller option `segments`: comma separated list, same style as `presets`:
`"segments": "Island,Sink,Segment 2"`.

- Matched against the segment `name`. An unnamed segment matches "Segment &lt;id&gt;", the label
  the WLED UI shows.
- Accessory UUID: `uuid.generate(address + ':segment:' + name)` – stable across reboots and id
  changes; renaming the segment in WLED means a new accessory (same as presets today).
- Display name: `<controller name> <segment name>`, so it's unique in HomeKit.

Rejected alternative: ids (`"0,2"`) – simpler, but ids shift when segments are deleted or a preset changes the
layout, and the user has to look them up.

### D3 – Brightness of a segment light: the segment brightness ✅ *decided 2026-10-15: segment brightness*

The segment light shows and sets the segment's own `bri` (0–255 → 0–100 %). The master brightness
stays on the controller light. Simple and predictable, but the actual output is master × segment,
so a segment at 100 % is only as bright as the master. Documented in the README.

Rejected alternative: show the effective brightness (master × segment) and set the segment so the product
matches. Closer to what you see, but jumps whenever the master changes and can't reach values above
the master.

### D4 – Turning a segment on while the controller is off ✅ *decided 2026-10-15: as described*

Segment On = `{ on: true, seg: [{ id, on: true }] }`: turns the master on too, otherwise nothing
lights up. Other segments that are still `on` light up as well. That matches what WLED's UI does
when you turn on a segment of a switched-off strip.

The segment light reports On only if master **and** segment are on, so HomeKit shows what is
actually lit. Segment Off only turns the segment off, never the master.

### D5 – The controller light keeps today's behavior

Master on/off and brightness stay as they are. Color/CCT of the controller light keep going to
segment 0 – changing that to "all segments" would change behavior for existing users. Possible
follow-up, not part of this plan.

### D6 – A configured segment that is missing

The accessory is registered from the config at startup (no need to wait for WLED). While the segment
isn't in the current state (not created yet, removed by a preset, controller offline), the segment
light answers with `SERVICE_COMMUNICATION_FAILURE` ("No Response") and the plugin logs one error per
missing segment until it shows up again. It doesn't unregister the accessory – a preset switching
the layout back would otherwise destroy rooms and automations.

Removed from the config → unregistered at the next start (same cleanup as controllers).

### D7 – Matter

Not part of this plan. PR 1 brings `WledDevice` to `main`, which makes the Matter branch easier to
resume later (it can then rebase on `main` instead of carrying the refactor).

## 4. Target architecture

```
WledWsHomebridgePlatform ─┬─ WledDevice (one per controller)
                          │    WLEDClient, reconnect/heartbeat, state, info, presets, commands
                          │    events: connected / disconnected / state / info / presets
                          ├─ WledWsPlatformAccessory (controller light + preset/live switches)
                          └─ WledSegmentAccessory    (one per configured segment, new)
```

- `WledDevice` gets segment helpers: `findSegment(name)` (name or "Segment &lt;id&gt;"),
  `segmentCapabilities(id)`, and commands with a segment id.
- `WledSegmentAccessory` keeps its own state in HomeKit units, subscribes to `state` / `info` /
  `connected` / `disconnected`, and looks its segment up again on every state (ids can change).
- Cached accessories carry `context.device` (controller config) plus `context.segment` (name);
  the platform's cleanup removes segment accessories whose controller or segment is no longer
  configured.

## 5. Implementation steps (one PR each)

### PR 1 – Extract `WledDevice`, no behavior change (~2 days)
- [ ] Port `src/WledDevice.ts` from `feat/matter-support` (without Matter code) onto `main` after
      #471–#475; the controller accessory becomes the HAP adapter on top of it.
- [ ] Platform creates one `WledDevice` per controller, attaches the accessory, connects; shutdown
      disconnects the devices.
- [ ] Existing tests adapted; `test/WledDevice.test.ts` for connection, presets, info.
- [ ] Verify: fake WLED + real Homebridge, same WLED traffic and HomeKit state as before (the
      replay harness from the Matter work, rebuilt under `test/e2e/` if worth keeping).

### PR 2 – Segment model and config (~1 day)
- [ ] `segments` option in `config.schema.json` (+ form), `WledController` interface, README.
- [ ] `WledDevice`: segment lookup by name / "Segment &lt;id&gt;", segment capabilities from `seglc`,
      commands with `segmentId`, `segments` in the state event.
- [ ] Log an error for configured segments that the controller doesn't have (like presets).
- [ ] Unit tests: lookup by name, unnamed segments, non-contiguous ids, layout change by a preset.

### PR 3 – Segment accessories: on/off and brightness (~2 days)
- [ ] `WledSegmentAccessory` with `Lightbulb` On + Brightness (D3, D4), "No Response" while the
      segment is missing or the controller is disconnected (D6).
- [ ] Platform registers/restores/unregisters segment accessories (UUID per D2).
- [ ] State from WLED updates the segment lights; changes made in WLED's UI show up in HomeKit.
- [ ] Unit tests for set/get, master-off cases, missing segment, cache cleanup.

### PR 4 – Color and color temperature per segment (~1 day)
- [ ] Hue/Saturation and ColorTemperature per segment depending on its capability, with the same
      conversions as the controller light (`WledUtils`).
- [ ] Unit tests per capability (RGB, RGBW, WCCT, RGBWCCT).

### PR 5 – Real-device test, docs, release (~1 day)
- [ ] Test on the Homebridge LXC container with a controller split into 2–3 segments: on/off,
      brightness (verify D3 and D4 assumptions), color, a preset that changes the layout, controller
      offline, segment removed from config.
- [ ] Apple Home: segment tiles in different rooms; a scene across two controllers (the
      cross-controller part of #318).
- [ ] README: new option, brightness semantics, update "Limitations"; CHANGELOG; answer on #318.

## 6. Open questions

- Is the segment `on` flag reliable on all firmware versions in the README compatibility table
  (0.13.x–0.15.x, and 16.x on the user's controllers)?
- Does WLED report `seglc` on older firmware? If not: fall back to the controller's
  `lightCapabilities`.
- Should a segment light offer its own effect/preset switches later? (Not now, see scope.)
- How many accessories per bridge is comfortable? Segments add one accessory each; a HomeKit bridge
  takes at most 149 bridged accessories.
