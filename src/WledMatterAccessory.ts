import { API, Logger, MatterAccessory } from 'homebridge';
import { WLEDClientState } from 'wled-client';
import { WledDevice, WledDeviceInfo } from './WledDevice';
import { LightCapability, WledPreset } from './WledController';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  brightnessToLevel,
  cctToMired,
  levelToBrightness,
  matterHsToRgb,
  miredToCct,
  rgbToMatterHs,
  rgbToXy,
  xyToRgb,
} from './WledUtils';

/**
 * A preset or playlist exposed as part of the Matter accessory
 */
export interface WledMatterPreset {
  id: string;
  name: string;
  isPlaylist: boolean;
}

/**
 * Structure of the Matter accessory: its device type follows the light capabilities, presets,
 * playlists and the live mode switch are child endpoints (parts)
 */
export interface WledMatterStructure {
  lightCapability: LightCapability;
  presets: WledMatterPreset[];
  live: boolean;
}

/**
 * Data stored with the Matter accessory in the Homebridge cache
 */
export interface WledMatterContext extends WledMatterStructure {
  address: string;
  info?: WledDeviceInfo;
}

const LIVE_PART_ID = 'live';
const presetPartId = (presetId: string) => `preset-${presetId}`;

// ColorControl color modes (Matter ColorControl.ColorMode)
const COLOR_MODE_HUE_SATURATION = 0;
const COLOR_MODE_XY = 1;
const COLOR_MODE_TEMPERATURE = 2;

// mired range of the WLED CCT conversion (see cctToMired)
const MIN_MIREDS = 140;
const MAX_MIREDS = 500;

/**
 * Timing of the Matter registration in milliseconds (exported for tests)
 */
export const matterTiming = {
  // how long to wait for Homebridge to apply a (un)registration
  registrationTimeout: 15000,
  registrationPoll: 50,
  // a registration dropped because the old accessory was not completely removed yet is repeated
  registrationRetry: 1000,
  // Homebridge closes the endpoint before it forgets the accessory, give it time to finish
  unregistrationSettle: 500,
  // a cached accessory is registered as cached if the controller does not report its structure in time
  startupWait: 15000,
  // presets arrive right after the device info; without them in time, no preset parts are exposed
  presetsWait: 5000,
};

// matter.js runs moveToHueAndSaturation as hue + saturation steps, all calling the handlers;
// an identical color command within this time is not sent to WLED again
const DUPLICATE_COMMAND_MILLIS = 1000;

// differences up to this value are treated as rounding noise of the RGB conversions
const HS_TOLERANCE = 1;
const XY_TOLERANCE = 100;

type ClusterState = Record<string, number | boolean>;

const hasColor = (lc: LightCapability) =>
  lc === LightCapability.RGB || lc === LightCapability.RGBW || lc === LightCapability.RGBWCCT;
const hasTemperature = (lc: LightCapability) =>
  lc === LightCapability.WCCT || lc === LightCapability.RGBWCCT;

/**
 * Matter adapter for a WledDevice. Exposes the controller as one Matter light whose device
 * type follows the light capabilities reported by WLED. Configured presets, playlists and the
 * live mode switch are on/off child endpoints (parts) of this light.
 *
 * The accessory keeps one UUID per controller. Matter cannot change the structure (device type,
 * features, parts) of a registered endpoint, so a structure change removes the accessory and
 * registers it again under the same UUID.
 */
export class WledMatterAccessory {
  readonly uuid: string;
  private context?: WledMatterContext;
  private cachedContext?: WledMatterContext;
  private registered = false;
  private info?: WledDeviceInfo;
  private presets?: WledPreset[];
  private presetsWaitOver = false;
  // serializes (un)registration and the state updates depending on it
  private queue: Promise<void> = Promise.resolve();
  private lastState?: WLEDClientState;
  // attribute values the Matter side currently has, per cluster
  private matterState: Record<string, ClusterState> = {};
  private lastColorCommand?: { key: string; time: number };

  /**
   * UUID of the Matter accessory of a controller
   */
  static uuidFor(api: API, address: string): string {
    return api.hap.uuid.generate(`matter:${address}`);
  }

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly device: WledDevice,
    private readonly loggingEnabled: boolean,
    cached?: MatterAccessory,
  ) {
    this.uuid = WledMatterAccessory.uuidFor(api, device.controller.address);

    // A cached accessory is registered once the controller reported its structure, so a changed
    // structure is registered once. If the controller is offline, it is registered as cached.
    const cachedContext = cached?.context as WledMatterContext | undefined;
    if (cachedContext?.lightCapability !== undefined) {
      // presets/live are missing in contexts cached before parts were supported
      this.cachedContext = {
        ...cachedContext,
        presets: cachedContext.presets ?? [],
        live: cachedContext.live ?? false,
      };
      setTimeout(() => this.enqueue(() => this.registerCachedIfPending()), matterTiming.startupWait).unref();
    }

    this.device.on('info', (info) => {
      this.info = info;
      if (this.presetsExpected) {
        setTimeout(() => {
          this.presetsWaitOver = true;
          this.enqueue(() => this.reconcile());
        }, matterTiming.presetsWait).unref();
      }
      this.enqueue(() => this.reconcile());
    });
    this.device.on('presets', (presets) => {
      this.presets = presets;
      this.enqueue(() => this.reconcile());
    });
    this.device.on('presetChanged', (preset) =>
      this.enqueue(() => this.pushPart(presetPartId(preset.id), preset.on)));
    this.device.on('state', (state) => this.onState(state));
    this.device.on('connected', () => this.enqueue(() => this.setReachable(true)));
    this.device.on('disconnected', () => this.enqueue(() => this.setReachable(false)));
  }

  /**
   * Returns a promise which resolves once all pending Matter operations are done
   */
  settled(): Promise<void> {
    return this.queue;
  }

  private enqueue(operation: () => Promise<void>) {
    this.queue = this.queue.then(operation).catch((error) => {
      this.log.error(
        'Matter update for controller %s failed: %s',
        this.device.controller.name,
        error instanceof Error ? error.message : error,
      );
    });
  }

  private get matter() {
    return this.api.matter!;
  }

  // presets are only exposed if the user configured some
  private get presetsExpected(): boolean {
    return !!this.device.controller.presets;
  }

  /**
   * The structure the controller currently reports, undefined while it is not known yet
   */
  private desiredStructure(): WledMatterStructure | undefined {
    if (!this.info) {
      return undefined;
    }
    if (this.presetsExpected && this.presets === undefined && !this.presetsWaitOver) {
      return undefined;
    }
    return {
      lightCapability: this.info.lightCapability,
      presets: (this.presets ?? []).map(({ id, name, isPlaylist }) => ({ id, name, isPlaylist })),
      live: !!this.device.controller.showRealTimeModeButton,
    };
  }

  private static structureKey(structure: WledMatterStructure): string {
    return JSON.stringify([
      structure.lightCapability,
      structure.presets.map((preset) => [preset.id, preset.name, preset.isPlaylist]),
      structure.live,
    ]);
  }

  /**
   * Register the accessory with the structure reported by the controller, re-register it if
   * the structure changed or update its metadata
   */
  private async reconcile() {
    const desired = this.desiredStructure();
    if (!desired) {
      return;
    }
    const key = WledMatterAccessory.structureKey(desired);

    if (!this.registered) {
      // a cached accessory with another structure is removed first, Matter can't change it in place
      const cached = this.cachedContext;
      this.cachedContext = undefined;
      if (cached && WledMatterAccessory.structureKey(cached) !== key) {
        this.log.info(
          'Structure of controller %s changed, re-registering Matter accessory',
          this.device.controller.name,
        );
        await this.unregister(cached.lightCapability);
      }
      await this.register(desired, this.info);
      return;
    }

    if (WledMatterAccessory.structureKey(this.context!) !== key) {
      this.log.info(
        'Structure of controller %s changed, re-registering Matter accessory',
        this.device.controller.name,
      );
      await this.unregister(this.context!.lightCapability);
      await this.register(desired, this.info);
      return;
    }

    if (JSON.stringify(this.context!.info) !== JSON.stringify(this.info)) {
      this.context!.info = this.info;
      await this.matter.updatePlatformAccessories([this.buildAccessory()]);
    }
  }

  // the controller did not report its structure in time, register the cached accessory as it is
  private async registerCachedIfPending() {
    const cached = this.cachedContext;
    if (this.registered || !cached) {
      return;
    }
    this.cachedContext = undefined;
    await this.register(cached, cached.info);
  }

  private async unregister(lightCapability: LightCapability) {
    // Homebridge needs the device type to find the server the accessory runs on
    const accessory: MatterAccessory = {
      UUID: this.uuid,
      displayName: this.device.controller.name,
      deviceType: this.deviceType(lightCapability),
      serialNumber: '',
      manufacturer: '',
      model: '',
      context: {},
    };
    await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.registered = false;
    this.matterState = {};
    await this.waitForRegistration(false);
    await new Promise((resolve) => setTimeout(resolve, matterTiming.unregistrationSettle));
  }

  private async register(structure: WledMatterStructure, info?: WledDeviceInfo) {
    this.context = {
      address: this.device.controller.address,
      lightCapability: structure.lightCapability,
      presets: structure.presets,
      live: structure.live,
      info,
    };

    // Homebridge applies registrations asynchronously and drops (only logs) one for a UUID which
    // is still being removed. So wait for the accessory to show up and repeat the registration.
    const accessory = this.buildAccessory();
    const deadline = Date.now() + matterTiming.registrationTimeout;
    for (;;) {
      await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      const attemptEnd = Math.min(deadline, Date.now() + matterTiming.registrationRetry);
      if (await this.waitForRegistration(true, attemptEnd)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('Matter accessory was not registered in time');
      }
    }
    this.registered = true;

    // start from what Matter actually has, a restored accessory keeps its cached state
    this.matterState = {};
    for (const [cluster, initial] of Object.entries(accessory.clusters ?? {})) {
      const current = await this.matter.getAccessoryState(this.uuid, cluster);
      this.matterState[cluster] = { ...(initial as ClusterState), ...(current as ClusterState) };
    }
    for (const part of accessory.parts ?? []) {
      const current = await this.matter.getAccessoryState(this.uuid, 'onOff', part.id);
      this.matterState[`part:${part.id}`] = { onOff: false, ...(current as ClusterState) };
    }

    if (this.loggingEnabled) {
      this.log.info(
        'Registered Matter accessory for controller %s (light capability %s, %s part(s))',
        this.device.controller.name,
        structure.lightCapability,
        accessory.parts?.length ?? 0,
      );
    }

    if (!this.device.connected) {
      await this.setReachable(false);
    }
    if (this.lastState) {
      await this.pushState(this.lastState);
    }
    for (const preset of this.device.presets) {
      await this.pushPart(presetPartId(preset.id), preset.on);
    }
  }

  /**
   * Wait until the accessory is (no longer) known to the Matter server. Homebridge applies
   * (un)registrations of bridged accessories asynchronously, the API calls resolve before.
   * @returns false if the deadline passed (only when a deadline is given), throws otherwise
   */
  private async waitForRegistration(present: boolean, deadline?: number): Promise<boolean> {
    const end = deadline ?? Date.now() + matterTiming.registrationTimeout;
    for (;;) {
      let state: unknown;
      try {
        state = await this.matter.getAccessoryState(this.uuid, 'onOff');
      } catch {
        state = undefined;
      }
      if ((state !== undefined) === present) {
        return true;
      }
      if (Date.now() >= end) {
        if (deadline !== undefined) {
          return false;
        }
        throw new Error(`Matter accessory was not ${present ? 'registered' : 'removed'} in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, matterTiming.registrationPoll));
    }
  }

  private buildAccessory(): MatterAccessory<WledMatterContext> {
    const controller = this.device.controller;
    const context = this.context!;
    const lc = context.lightCapability;
    const info = context.info;

    return {
      UUID: this.uuid,
      displayName: controller.name,
      deviceType: this.deviceType(lc),
      serialNumber: info?.mac || controller.address,
      manufacturer: info?.brand || 'WLED',
      model: info?.product || PLUGIN_NAME,
      firmwareRevision: info?.version,
      context,
      clusters: this.initialClusters(lc),
      handlers: this.handlers(lc),
      parts: this.parts(context),
    };
  }

  /**
   * Presets, playlists and the live mode switch as on/off child endpoints
   */
  private parts(structure: WledMatterStructure) {
    const outlet = this.matter.deviceTypes.OnOffOutlet;
    const parts: NonNullable<MatterAccessory['parts']> = structure.presets.map((preset) => ({
      id: presetPartId(preset.id),
      displayName: preset.name,
      deviceType: outlet,
      clusters: { onOff: { onOff: false } },
      handlers: {
        onOff: {
          on: async () => this.setPreset(preset.id, true),
          off: async () => this.setPreset(preset.id, false),
          toggle: async () => this.setPreset(preset.id, !this.partState(presetPartId(preset.id))),
        },
      },
    }));

    if (structure.live) {
      parts.push({
        id: LIVE_PART_ID,
        // same name as the HomeKit switch
        displayName: 'Ambilight',
        deviceType: outlet,
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: async () => this.setLive(true),
            off: async () => this.setLive(false),
            toggle: async () => this.setLive(!this.partState(LIVE_PART_ID)),
          },
        },
      });
    }

    return parts.length > 0 ? parts : undefined;
  }

  private deviceType(lc: LightCapability) {
    const deviceTypes = this.matter.deviceTypes;
    if (hasColor(lc)) {
      return deviceTypes.ExtendedColorLight;
    }
    if (lc === LightCapability.WCCT) {
      return deviceTypes.ColorTemperatureLight;
    }
    if (lc === LightCapability.White) {
      return deviceTypes.DimmableLight;
    }
    return deviceTypes.OnOffLight;
  }

  private initialClusters(lc: LightCapability) {
    const clusters: Record<string, ClusterState> = {
      onOff: { onOff: false },
    };

    if (lc !== LightCapability.OnOff) {
      clusters.levelControl = { currentLevel: 254, minLevel: 1, maxLevel: 254 };
    }

    if (hasColor(lc) || hasTemperature(lc)) {
      const colorControl: ClusterState = {
        colorMode: hasColor(lc) ? COLOR_MODE_HUE_SATURATION : COLOR_MODE_TEMPERATURE,
      };
      if (hasColor(lc)) {
        Object.assign(colorControl, { currentHue: 0, currentSaturation: 0 }, this.xy(255, 255, 255));
      }
      if (hasTemperature(lc)) {
        Object.assign(colorControl, {
          colorTemperatureMireds: cctToMired(127),
          colorTempPhysicalMinMireds: MIN_MIREDS,
          colorTempPhysicalMaxMireds: MAX_MIREDS,
          // mandatory with the ColorTemperature feature
          coupleColorTempToLevelMinMireds: MIN_MIREDS,
        });
      }
      clusters.colorControl = colorControl;
    }

    return clusters;
  }

  private xy(r: number, g: number, b: number) {
    const { x, y } = rgbToXy(r, g, b);
    return { currentX: x, currentY: y };
  }

  /**
   * Command handlers. Homebridge derives the ColorControl features from the handlers present,
   * so only handlers for supported features are returned.
   *
   * matter.js also calls handlers internally (e.g. stopAllColorMovement before a color change).
   * A missing handler, or one throwing on such an internal call, ends up as an unhandled error
   * which stops Homebridge. So every handler of a present cluster is provided, and the ones
   * without a WLED equivalent never throw.
   */
  private handlers(lc: LightCapability) {
    const handlers: MatterAccessory['handlers'] = {
      onOff: {
        on: async () => this.setOn(true),
        off: async () => this.setOn(false),
        toggle: async () => this.setOn(!(this.lastState?.on ?? false)),
      },
    };

    if (lc !== LightCapability.OnOff) {
      handlers.levelControl = {
        moveToLevel: async ({ level }) => this.setLevel(level, false),
        moveToLevelWithOnOff: async ({ level }) => this.setLevel(level, true),
        step: async ({ stepMode, stepSize }) => this.stepLevel(stepMode, stepSize),
        // continuous dimming has no WLED equivalent, the next WLED state update corrects the level
        move: async () => undefined,
        stop: async () => undefined,
      };
    }

    const colorControl: NonNullable<MatterAccessory['handlers']>['colorControl'] = {};
    if (hasColor(lc)) {
      colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) =>
        this.setHueSaturation(hue, saturation);
      colorControl.moveToHueLogic = async ({ targetHue }) =>
        this.setHueSaturation(targetHue, this.colorValue('currentSaturation'));
      colorControl.moveToSaturationLogic = async ({ targetSaturation }) =>
        this.setHueSaturation(this.colorValue('currentHue'), targetSaturation);
      colorControl.moveToColorLogic = async ({ targetX, targetY }) => this.setXy(targetX, targetY);
    }
    if (hasTemperature(lc)) {
      colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) =>
        this.setColorTemperature(colorTemperatureMireds);
    }
    if (Object.keys(colorControl).length > 0) {
      // WLED applies colors immediately, there is no movement to stop
      colorControl.stopAllColorMovement = async () => undefined;
      handlers.colorControl = colorControl;
    }

    return handlers;
  }

  private ensureConnected() {
    if (!this.device.connected) {
      this.log.error('No connection to controller %s', this.device.controller.name);
      throw new Error(`No connection to controller ${this.device.controller.name}`);
    }
  }

  private logCommand(format: string, ...args: unknown[]) {
    if (this.loggingEnabled) {
      this.log.info(`Matter: set controller %s ${format}`, this.device.controller.name, ...args);
    }
  }

  private colorValue(attribute: string): number {
    return (this.matterState.colorControl?.[attribute] as number) ?? 0;
  }

  // remember what a command set, so the echo from WLED is not pushed back with rounding noise
  private expect(cluster: string, attributes: ClusterState) {
    this.matterState[cluster] = { ...this.matterState[cluster], ...attributes };
  }

  private setOn(on: boolean) {
    this.ensureConnected();
    this.logCommand('On state to: %s', on ? 'On' : 'Off');
    this.expect('onOff', { onOff: on });
    if (on) {
      this.device.turnOn();
    } else {
      this.device.turnOff();
    }
  }

  private setLevel(level: number, withOnOff: boolean) {
    this.ensureConnected();
    this.logCommand('level to: %s', level);
    this.expect('levelControl', { currentLevel: level });

    // like Matter: a *WithOnOff command at the minimum level turns the light off, any other level on
    if (withOnOff && level <= 1) {
      this.expect('onOff', { onOff: false });
      this.device.turnOff();
      return;
    }
    if (withOnOff) {
      this.expect('onOff', { onOff: true });
      this.device.turnOn();
    }
    this.device.setBrightness(levelToBrightness(level));
  }

  // true if the same color command was just sent (see DUPLICATE_COMMAND_MILLIS)
  private isDuplicateColorCommand(...values: number[]): boolean {
    const key = values.join(',');
    const now = Date.now();
    const duplicate =
      this.lastColorCommand?.key === key && now - this.lastColorCommand.time < DUPLICATE_COMMAND_MILLIS;
    this.lastColorCommand = { key, time: now };
    return duplicate;
  }

  private stepLevel(stepMode: number, stepSize: number) {
    // LevelControl.StepMode: 0 = up, 1 = down
    const current = (this.matterState.levelControl?.currentLevel as number) ?? 254;
    const level = Math.min(254, Math.max(1, current + (stepMode === 0 ? stepSize : -stepSize)));
    this.setLevel(level, false);
  }

  private setHueSaturation(hue: number, saturation: number) {
    this.ensureConnected();
    const { r, g, b } = matterHsToRgb(hue, saturation);
    if (this.isDuplicateColorCommand(r, g, b)) {
      return;
    }
    this.logCommand('hue/saturation to: %s/%s (RGB: %s,%s,%s)', hue, saturation, r, g, b);
    this.expect('colorControl', {
      currentHue: hue,
      currentSaturation: saturation,
      ...this.xy(r, g, b),
      colorMode: COLOR_MODE_HUE_SATURATION,
    });
    this.device.setColor([r, g, b]);
  }

  private setXy(x: number, y: number) {
    this.ensureConnected();
    const { r, g, b } = xyToRgb(x, y);
    if (this.isDuplicateColorCommand(r, g, b)) {
      return;
    }
    const { hue, saturation } = rgbToMatterHs(r, g, b);
    this.logCommand('xy color to: %s/%s (RGB: %s,%s,%s)', x, y, r, g, b);
    this.expect('colorControl', {
      currentX: x,
      currentY: y,
      currentHue: hue,
      currentSaturation: saturation,
      colorMode: COLOR_MODE_XY,
    });
    this.device.setColor([r, g, b]);
  }

  private setColorTemperature(mireds: number) {
    this.ensureConnected();
    const cct = miredToCct(mireds);
    if (this.isDuplicateColorCommand(-1, cct)) {
      return;
    }
    this.logCommand('color temperature to: %s mired (CCT %s)', mireds, cct);
    this.expect('colorControl', { colorTemperatureMireds: mireds, colorMode: COLOR_MODE_TEMPERATURE });
    // same as HomeKit: white channel only, the CCT selects the temperature
    this.device.setColor([0, 0, 0, 255]);
    this.device.setCCT(cct);
  }

  private hasPart(partId: string): boolean {
    const context = this.context!;
    return partId === LIVE_PART_ID
      ? context.live
      : context.presets.some((preset) => presetPartId(preset.id) === partId);
  }

  private partState(partId: string): boolean {
    return (this.matterState[`part:${partId}`]?.onOff as boolean) ?? false;
  }

  private setPreset(presetId: string, on: boolean) {
    this.ensureConnected();
    const preset = this.device.presets.find((candidate) => candidate.id === presetId);
    if (!preset) {
      throw new Error(`Preset ${presetId} is not available on controller ${this.device.controller.name}`);
    }
    this.expect(`part:${presetPartId(presetId)}`, { onOff: on });
    this.device.setPreset(preset, on);
  }

  private setLive(live: boolean) {
    this.ensureConnected();
    this.logCommand('live mode to: %s', live ? 'On' : 'Off');
    this.expect(`part:${LIVE_PART_ID}`, { onOff: live });
    this.device.setLive(live);
  }

  /**
   * Push the on/off state of a part to Matter
   */
  private async pushPart(partId: string, on: boolean) {
    if (!this.registered || !this.hasPart(partId)) {
      return;
    }
    const key = `part:${partId}`;
    if (this.matterState[key]?.onOff === on) {
      return;
    }
    this.expect(key, { onOff: on });
    await this.matter.updateAccessoryState(this.uuid, 'onOff', { onOff: on }, partId);
  }

  /**
   * Controller state received: push changed attributes to Matter
   */
  private onState(state: WLEDClientState) {
    this.lastState = state;
    this.enqueue(async () => {
      if (this.registered && this.lastState === state) {
        await this.pushState(state);
      }
    });
  }

  private async pushState(state: WLEDClientState) {
    const lc = this.context!.lightCapability;
    const target: Record<string, ClusterState> = {
      onOff: { onOff: state.on },
    };

    if (lc !== LightCapability.OnOff) {
      target.levelControl = { currentLevel: brightnessToLevel(state.brightness) };
    }

    if (hasColor(lc) || hasTemperature(lc)) {
      const segment = state.segments[0];
      const colorControl: ClusterState = {};
      const [r, g, b] = segment.colors?.[0] ?? [0, 0, 0];
      // the white channel only (RGB off) means color temperature mode
      const whiteOnly = r === 0 && g === 0 && b === 0;

      if (hasColor(lc) && !whiteOnly) {
        const { hue, saturation } = rgbToMatterHs(r, g, b);
        Object.assign(colorControl, { currentHue: hue, currentSaturation: saturation }, this.xy(r, g, b));
        if (this.colorValue('colorMode') === COLOR_MODE_TEMPERATURE) {
          colorControl.colorMode = COLOR_MODE_HUE_SATURATION;
        }
      }
      if (hasTemperature(lc) && segment.cct !== undefined) {
        colorControl.colorTemperatureMireds = cctToMired(segment.cct);
        if (whiteOnly || !hasColor(lc)) {
          colorControl.colorMode = COLOR_MODE_TEMPERATURE;
        }
      }
      target.colorControl = colorControl;
    }

    // liveDataOverride === 0 means live mode is active
    await this.pushPart(LIVE_PART_ID, state.liveDataOverride === 0);

    for (const [cluster, attributes] of Object.entries(target)) {
      const changed = this.changedAttributes(cluster, attributes);
      if (Object.keys(changed).length === 0) {
        continue;
      }
      if (changed.colorMode !== undefined) {
        changed.enhancedColorMode = changed.colorMode;
      }
      this.expect(cluster, changed);
      await this.matter.updateAccessoryState(this.uuid, cluster, changed);
    }
  }

  private changedAttributes(cluster: string, attributes: ClusterState): ClusterState {
    const current = this.matterState[cluster] ?? {};
    const changed: ClusterState = {};
    for (const [name, value] of Object.entries(attributes)) {
      const old = current[name];
      let tolerance = 0;
      if (name === 'currentHue' || name === 'currentSaturation') {
        tolerance = HS_TOLERANCE;
      } else if (name === 'currentX' || name === 'currentY') {
        tolerance = XY_TOLERANCE;
      }
      if (
        typeof value === 'number' && typeof old === 'number'
          ? Math.abs(value - old) > tolerance
          : value !== old
      ) {
        changed[name] = value;
      }
    }
    return changed;
  }

  private async setReachable(reachable: boolean) {
    if (!this.registered) {
      return;
    }
    await this.matter.updateAccessoryState(this.uuid, 'bridgedDeviceBasicInformation', { reachable });
  }
}
