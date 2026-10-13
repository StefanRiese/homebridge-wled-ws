import { API, Logger, MatterAccessory } from 'homebridge';
import { WLEDClientState } from 'wled-client';
import { WledDevice, WledDeviceInfo } from './WledDevice';
import { LightCapability } from './WledController';
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
 * Data stored with the Matter accessory in the Homebridge cache
 */
export interface WledMatterContext {
  address: string;
  lightCapability: LightCapability;
  info?: WledDeviceInfo;
}

// ColorControl color modes (Matter ColorControl.ColorMode)
const COLOR_MODE_HUE_SATURATION = 0;
const COLOR_MODE_XY = 1;
const COLOR_MODE_TEMPERATURE = 2;

// mired range of the WLED CCT conversion (see cctToMired)
const MIN_MIREDS = 140;
const MAX_MIREDS = 500;

// how long to wait for Homebridge to apply a (un)registration
const REGISTRATION_TIMEOUT_MILLIS = 10000;
const REGISTRATION_POLL_MILLIS = 50;

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
 * Matter adapter for a WledDevice. Exposes the controller as a Matter light whose device
 * type follows the light capabilities reported by WLED.
 */
export class WledMatterAccessory {
  private uuid?: string;
  private context?: WledMatterContext;
  private registered = false;
  // serializes (un)registration and the state updates depending on it
  private queue: Promise<void> = Promise.resolve();
  private lastState?: WLEDClientState;
  // attribute values the Matter side currently has, per cluster
  private matterState: Record<string, ClusterState> = {};
  private lastColorCommand?: { key: string; time: number };

  /**
   * UUID of the Matter accessory of a controller. The device type depends on the light
   * capabilities, so they are part of the UUID: a changed capability means a new accessory,
   * and the old one can be removed without racing the registration of the new one.
   */
  static uuidFor(api: API, address: string, lightCapability: LightCapability): string {
    return api.hap.uuid.generate(`matter:${address}:${lightCapability}`);
  }

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly device: WledDevice,
    private readonly loggingEnabled: boolean,
    cached?: MatterAccessory,
  ) {
    // register a cached accessory right away, so controllers get answers before WLED is connected
    const cachedContext = cached?.context as WledMatterContext | undefined;
    if (cachedContext?.lightCapability !== undefined) {
      this.enqueue(() => this.register(cachedContext.lightCapability, cachedContext.info));
    }

    this.device.on('info', (info) => this.enqueue(() => this.onInfo(info)));
    this.device.on('state', (state) => this.onState(state));
    this.device.on('connected', () => this.enqueue(() => this.setReachable(true)));
    this.device.on('disconnected', () => this.enqueue(() => this.setReachable(false)));
  }

  /**
   * UUID of the registered Matter accessory
   */
  get accessoryUuid(): string | undefined {
    return this.uuid;
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

  /**
   * Device info received: register the accessory, or re-register it if the light capabilities
   * changed (the Matter device type depends on them)
   */
  private async onInfo(info: WledDeviceInfo) {
    if (!this.registered) {
      await this.register(info.lightCapability, info);
      return;
    }

    if (this.context!.lightCapability !== info.lightCapability) {
      this.log.info(
        'Light capabilities of controller %s changed, re-registering Matter accessory',
        this.device.controller.name,
      );
      await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.buildAccessory()]);
      this.registered = false;
      this.matterState = {};
      await this.register(info.lightCapability, info);
      return;
    }

    if (JSON.stringify(this.context!.info) !== JSON.stringify(info)) {
      this.context!.info = info;
      await this.matter.updatePlatformAccessories([this.buildAccessory()]);
    }
  }

  private async register(lightCapability: LightCapability, info?: WledDeviceInfo) {
    this.uuid = WledMatterAccessory.uuidFor(this.api, this.device.controller.address, lightCapability);
    this.context = {
      address: this.device.controller.address,
      lightCapability,
      info,
    };

    const accessory = this.buildAccessory();
    await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    await this.waitForRegistration();
    this.registered = true;

    // start from what Matter actually has, a restored accessory keeps its cached state
    this.matterState = {};
    for (const [cluster, initial] of Object.entries(accessory.clusters ?? {})) {
      const current = await this.matter.getAccessoryState(this.uuid!, cluster);
      this.matterState[cluster] = { ...(initial as ClusterState), ...(current as ClusterState) };
    }

    if (this.loggingEnabled) {
      this.log.info(
        'Registered Matter accessory for controller %s (light capability %s)',
        this.device.controller.name,
        lightCapability,
      );
    }

    if (!this.device.connected) {
      await this.setReachable(false);
    }
    if (this.lastState) {
      await this.pushState(this.lastState);
    }
  }

  /**
   * Homebridge applies registrations of bridged accessories asynchronously, the API call
   * resolves before. Wait until the accessory is known to the Matter server.
   */
  private async waitForRegistration() {
    const deadline = Date.now() + REGISTRATION_TIMEOUT_MILLIS;
    for (;;) {
      let state: unknown;
      try {
        state = await this.matter.getAccessoryState(this.uuid!, 'onOff');
      } catch {
        state = undefined;
      }
      if (state !== undefined) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error('Matter accessory was not registered in time');
      }
      await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MILLIS));
    }
  }

  private buildAccessory(): MatterAccessory<WledMatterContext> {
    const controller = this.device.controller;
    const context = this.context!;
    const lc = context.lightCapability;
    const info = context.info;

    return {
      UUID: this.uuid!,
      displayName: controller.name,
      deviceType: this.deviceType(lc),
      serialNumber: info?.mac || controller.address,
      manufacturer: info?.brand || 'WLED',
      model: info?.product || PLUGIN_NAME,
      firmwareRevision: info?.version,
      context,
      clusters: this.initialClusters(lc),
      handlers: this.handlers(lc),
    };
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

    for (const [cluster, attributes] of Object.entries(target)) {
      const changed = this.changedAttributes(cluster, attributes);
      if (Object.keys(changed).length === 0) {
        continue;
      }
      if (changed.colorMode !== undefined) {
        changed.enhancedColorMode = changed.colorMode;
      }
      this.expect(cluster, changed);
      await this.matter.updateAccessoryState(this.uuid!, cluster, changed);
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
    await this.matter.updateAccessoryState(this.uuid!, 'bridgedDeviceBasicInformation', { reachable });
  }
}
