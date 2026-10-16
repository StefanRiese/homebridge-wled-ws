import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';
import { WLEDClientState } from 'wled-client';
import { WledWsHomebridgePlatform } from './WledWsHomebridgePlatform';
import {
  WledController,
  LightCapability,
  WledPreset,
} from './WledController';
import { WledDevice, WledDeviceInfo } from './WledDevice';
import { Logger } from 'homebridge';
import { PLUGIN_NAME, PLUGIN_AUTHOR } from './settings';
import { rgbToHsv, hsvToRgb, miredToCct, cctToMired } from './WledUtils';

/**
 * Platform Accessory
 * HomeKit adapter for a WledDevice. An instance of this class is created for each accessory
 * your platform registers. Each accessory may expose multiple services of different service types.
 */
export class WledWsPlatformAccessory {
  private service: Service;
  private realTimeService?: Service;
  private presetServices = new Map<string, Service>();

  /**
   * Tracks the LED state in HomeKit units
   */
  private ledState = {
    On: false,
    Live: false,
    Brightness: 100,
    Hue: 0,
    Saturation: 0,
    Value: 0,
    ColorTemperature: 300,
    LightCapability: LightCapability.OnOff,
  };

  constructor(
    private readonly platform: WledWsHomebridgePlatform,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly device: WledDevice,
    private readonly loggingEnabled: boolean,
  ) {
    this.log = log;

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    // in case more services are added, this one will be our primary service
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name,
    );
    this.service.setPrimaryService(true);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Set initial accessory information - this will be overwritten as soon as the controller is connected
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLUGIN_AUTHOR,
      )
      .setCharacteristic(this.platform.Characteristic.Model, PLUGIN_NAME)
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        'not set',
      )
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'not set');

    // check if real time mode button should be shown
    const controller = <WledController>this.accessory.context.device;
    if (controller.showRealTimeModeButton) {
      // get switch service if it exists, otherwise create a new switch service
      this.realTimeService =
        this.accessory.getServiceById(
          this.platform.Service.Switch,
          'WLED-LIVE',
        ) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          'Live Mode',
          'WLED-LIVE',
        );

      // name set to ambilight as most people are familiar with this term
      this.realTimeService.setCharacteristic(
        this.platform.Characteristic.Name,
        'Ambilight',
      );

      // register handlers for the On/Off Characteristic
      this.realTimeService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.liveSetOn.bind(this))
        .onGet(this.liveGetOn.bind(this));

      // link service to main service
      this.service.addLinkedService(this.realTimeService);
    } else {
      // remove the switch restored from the cache if the button has been turned off
      const cachedRealTimeService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        'WLED-LIVE',
      );
      if (cachedRealTimeService) {
        this.platform.log.debug(
          'Remove cached real time mode switch for controller %s',
          controller.name,
        );
        this.service.removeLinkedService(cachedRealTimeService);
        this.accessory.removeService(cachedRealTimeService);
      }
    }

    // preset switches restored from the cache get their handlers once the presets are received.
    // Until then reject changes, otherwise HomeKit would accept them without anything happening
    for (const presetSwitchService of this.accessory.services) {
      if (presetSwitchService.subtype?.startsWith('WLED-PRESET-')) {
        presetSwitchService
          .getCharacteristic(this.platform.Characteristic.On)
          .onGet(() => false)
          .onSet(() => this.rejectPresetNotLoaded());
      }
    }

    // follow the controller
    this.device.on('state', (state) => this.onStateReceived(state));
    this.device.on('info', (info) => this.updateAccessoryInformation(info));
    this.device.on('presets', (presets) => this.onPresetsReceived(presets));
    this.device.on('presetChanged', (preset) => this.onPresetChanged(preset));
  }

  /**
   * Rejects HomeKit requests while the controller is not connected
   */
  private ensureConnected() {
    if (!this.device.connected) {
      const controller = <WledController>this.accessory.context.device;
      this.platform.log.error('No connection to controller %s', controller.name);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    this.ledState.On = value as boolean;

    if (this.loggingEnabled){
      this.platform.log.info(
        'Set controller %s On state to: %s',
        controller.name,
        value ? 'On' : 'Off',
      );
    }
    if (value) {
      this.device.turnOn();
    } else {
      this.device.turnOff();
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.ledState.On;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug(
      'Get controller %s On state: %s',
      controller.name,
      isOn ? 'On' : 'Off',
    );
    return isOn;
  }

  /**
   * Set if the real time mode is active. This is a separate switch in Homekit to enable/disable
   */
  async liveSetOn(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    this.ledState.Live = value as boolean;

    if (this.loggingEnabled){
      this.platform.log.info(
        'Set controller %s On state to: %s',
        controller.name,
        value ? 'On' : 'Off',
      );
    }

    this.device.setLive(value as boolean);
  }

  /**
   * Returns the real time mode state to Homekit
   */
  async liveGetOn(): Promise<CharacteristicValue> {
    const isLive = this.ledState.Live;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug(
      'Get controller %s Live state: %s',
      controller.name,
      isLive ? 'On' : 'Off',
    );
    return isLive;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setBrightness(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    this.ledState.Brightness = value as number;

    if (this.loggingEnabled){
      this.platform.log.info(
        'Set controller %s brightness to: %s',
        controller.name,
        value,
      );
    }
    this.device.setBrightness(
      Math.round((this.ledState.Brightness * 255) / 100),
    );
  }

  /**
   * Returns current brightness to Homekit
   */
  async getBrightness(): Promise<CharacteristicValue> {
    const brightness = this.ledState.Brightness;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug(
      'Get controller %s brightness: %s',
      controller.name,
      brightness,
    );
    return brightness;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Hue
   */
  async setHue(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    this.ledState.Hue = value as number;

    const { r, g, b } = hsvToRgb(
      (value as number) / 360,
      this.ledState.Saturation / 100,
      1.0,
    );

    if (this.loggingEnabled){
      this.platform.log.info(
        `Set controller %s hue to: %s (RGB: ${r},${g},${b})`,
        controller.name,
        value,
      );
    }
    this.device.setColor([r, g, b]);
  }

  /**
   * Returns the Hue value to Homekit
   */
  async getHue(): Promise<CharacteristicValue> {
    const hue = this.ledState.Hue;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug('Get controller %s hue: %s', controller.name, hue);
    return hue;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Saturation
   */
  async setSaturation(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    this.ledState.Saturation = value as number;
    const { r, g, b } = hsvToRgb(
      this.ledState.Hue / 360,
      (value as number) / 100,
      1.0,
    );

    if (this.loggingEnabled){
      this.platform.log.info(
        `Set controller %s saturation to: %s (RGB: ${r},${g},${b})`,
        controller.name,
        value,
      );
    }
    this.device.setColor([r, g, b]);
  }

  /**
   * Returns the saturation value to Homekit
   */
  async getSaturation(): Promise<CharacteristicValue> {
    const saturation = this.ledState.Saturation;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug(
      'Get controller %s saturation: %s',
      controller.name,
      saturation,
    );
    return saturation;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Color Temperature
   */
  async setColorTemperature(value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    const controller = <WledController>this.accessory.context.device;

    // HomeKit works with mired, WLED with a CCT value 0..255
    this.ledState.ColorTemperature = value as number;
    const cct = miredToCct(value as number);

    this.platform.log.info(`Set controller %s temperature to: %s `, controller.name, cct);
    this.device.setColor([0, 0, 0, 255]);
    this.device.setCCT(cct);
  }

  /**
   * Returns the temperature value (mired) to Homekit
   */
  async getColorTemperature(): Promise<CharacteristicValue> {
    const temperature = this.ledState.ColorTemperature;
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.debug('Get controller %s temperature: %s', controller.name, temperature);
    return temperature;
  }

  /**
   * Sets the preset state from Homekit
   */
  async setPreset(preset: WledPreset, value: CharacteristicValue) {
    // only proceed if controller is connected
    this.ensureConnected();
    this.device.setPreset(preset, value as boolean);
  }

  /**
   * Rejects a change of a cached preset switch whose preset has not been received from the controller yet
   */
  rejectPresetNotLoaded(): never {
    const controller = <WledController>this.accessory.context.device;
    this.platform.log.error(
      'Presets of controller %s not loaded yet',
      controller.name,
    );
    throw new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  /**
   * Returns the preset state to Homekit
   */
  async getPreset(preset: WledPreset): Promise<CharacteristicValue> {
    this.platform.log.debug(
      'Get On state for %s %s (%s) of controller %s: %s',
      preset.isPlaylist ? 'playlist' : 'preset',
      preset.id,
      preset.name,
      this.device.controller.name,
      preset.on ? 'On' : 'Off',
    );
    return preset.on;
  }

  /**
   * Callback: each time controller's state changes this function is called. State changes can
   * triggered by user interaction or other clients
   */
  onStateReceived(state: WLEDClientState) {
    const controller = <WledController>this.accessory.context.device;

    if (this.ledState.On !== state.on) {
      this.ledState.On = state.on;

      if (this.loggingEnabled){
        this.platform.log.info(
          'Controller %s updated current On state to: %s',
          controller.name,
          this.ledState.On,
        );
      }

      this.service.updateCharacteristic(
        this.platform.Characteristic.On,
        this.ledState.On,
      );
    }

    // liveDataOverride === 0 means live mode is active
    if (this.ledState.Live !== (state.liveDataOverride === 0)) {
      this.ledState.Live = state.liveDataOverride === 0;

      if (this.loggingEnabled){
        this.platform.log.info(
          'Controller %s updated current Live state to: %s',
          controller.name,
          this.ledState.Live,
        );
      }

      if (this.realTimeService) {
        this.realTimeService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.ledState.Live,
        );
      }
    }

    if (this.ledState.LightCapability !== LightCapability.OnOff) {
      const brightness = Math.round(
        (state.brightness * 100) / 255,
      );
      if (this.ledState.Brightness !== brightness) {
        this.ledState.Brightness = brightness;

        if (this.loggingEnabled){
          this.platform.log.info(
            'Controller %s updated current brightness to: %s',
            controller.name,
            this.ledState.Brightness,
          );
        }

        this.service.updateCharacteristic(
          this.platform.Characteristic.Brightness,
          this.ledState.Brightness,
        );
      }
    }

    // update current color settings (if changed outside Homekit)
    if (
      this.ledState.LightCapability === LightCapability.RGB ||
      this.ledState.LightCapability === LightCapability.RGBW ||
      this.ledState.LightCapability === LightCapability.RGBWCCT
    ) {
      const val = state.segments[0].colors![0];
      const { h, s, v } = rgbToHsv(val[0], val[1], val[2]);
      if (
        this.ledState.Hue !== h * 360 ||
        this.ledState.Saturation !== s * 100 ||
        this.ledState.Value !== v * 100
      ) {
        this.platform.log.debug(
          'Controller %s updated current color to: RGB %s:%s:%s -> HSV %s:%s:%s',
          controller.name,
          val[0],
          val[1],
          val[2],
          h,
          s,
          v,
        );

        // store new values and update Homekit
        this.ledState.Hue = h * 360;
        this.ledState.Saturation = s * 100;
        this.ledState.Value = v * 100;
        this.service.updateCharacteristic(
          this.platform.Characteristic.Hue,
          this.ledState.Hue,
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.Saturation,
          this.ledState.Saturation,
        );
      }
    }

    // update current color temperature (if changed outside Homekit)
    if (this.ledState.LightCapability === LightCapability.WCCT ||
        this.ledState.LightCapability === LightCapability.RGBWCCT) {
      const val = state.segments[0].cct!;
      const mired = cctToMired(val);
      if (this.ledState.ColorTemperature !== mired) {
        this.ledState.ColorTemperature = mired;

        if (this.loggingEnabled){
          this.platform.log.info('Controller %s updated current color temperture to: %s', controller.name, val);
        }

        this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.ledState.ColorTemperature);
      }
    }
  }

  /**
   * Callback: the list of configured presets available on the controller was received.
   * Adds a switch for each preset and removes switches of presets which are not available anymore.
   */
  onPresetsReceived(presets: WledPreset[]) {
    const controller = this.device.controller;

    for (const preset of presets) {
      // add a switch for each preset in Homekit
      let presetSwitchService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        'WLED-PRESET-' + preset.id,
      );
      if (presetSwitchService === undefined) {
        presetSwitchService = this.accessory.addService(
          this.platform.Service.Switch,
          preset.name,
          'WLED-PRESET-' + preset.id,
        );
        presetSwitchService.addOptionalCharacteristic(
          this.platform.Characteristic.ConfiguredName,
        );
        presetSwitchService.setCharacteristic(
          this.platform.Characteristic.ConfiguredName,
          preset.name,
        );
        this.service.addLinkedService(presetSwitchService);
      }

      presetSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.getPreset(preset))
        .onSet((value) => this.setPreset(preset, value));

      // store them for later usage
      this.presetServices.set(preset.id, presetSwitchService);

      this.platform.log.debug(
        'Added %s switch %s (id:%s) for controller %s',
        preset.isPlaylist ? 'playlist' : 'preset',
        preset.name,
        preset.id,
        controller.name,
      );
    }

    // Delete orphaned services which were created earlier and not needed anymore
    for (let i = 0; i <= 250; i++) {
      const cachedService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        'WLED-PRESET-' + i,
      );
      if (cachedService) {
        if (!presets.some((obj) => obj.id === i.toString())) {
          this.platform.log.debug(
            'Remove cached preset switch with id %s for controller',
            i,
            controller.name,
          );
          this.service.removeLinkedService(cachedService);
          this.accessory.removeService(cachedService);
          this.presetServices.delete(i.toString());
        }
      }
    }
  }

  /**
   * Callback: the on state of a preset/playlist was changed by the controller
   */
  onPresetChanged(preset: WledPreset) {
    this.presetServices.get(preset.id)?.updateCharacteristic(
      this.platform.Characteristic.On,
      preset.on,
    );
  }

  /**
   * After successful connect to the controller, its properties are read and set as
   * accessory information. The plugin adds its services and characteristics according
   * to the light capabilities of the controller.
   *
   * The following behaviour is implemented:
   * Single Color LED stripe or OnOff only: LightBulb with characteristic On and Brightness
   * RGB Color LED stripe: LightBulb with characteristic On, Brightness, Hue, Saturation
   * RGB Color LED stripe with White LED:
   *        - LightBulb with characteristic On, Brightness, Hue, Saturation for RGB
   *        - ColorTemperture characteristic is used if WLED reports CCT supported
   */
  updateAccessoryInformation(info: WledDeviceInfo) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        info.brand,
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        info.product,
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        info.version,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        info.mac,
      );

    const lc = info.lightCapability;

    // register handlers for the Brightness Characteristic
    if (
      lc > LightCapability.OnOff
    ) {
      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setBrightness.bind(this))
        .onGet(this.getBrightness.bind(this));
    }

    // register handlers for the Hue and Saturation Characteristic
    if (lc === LightCapability.RGB || lc === LightCapability.RGBW || lc === LightCapability.RGBWCCT) {
      this.service
        .getCharacteristic(this.platform.Characteristic.Hue)
        .onSet(this.setHue.bind(this))
        .onGet(this.getHue.bind(this));

      this.service
        .getCharacteristic(this.platform.Characteristic.Saturation)
        .onGet(this.getSaturation.bind(this))
        .onSet(this.setSaturation.bind(this));
    }

    // register handlers for the Color Temperature Characteristic
    if (lc === LightCapability.WCCT || lc === LightCapability.RGBWCCT) {
      this.service
        .getCharacteristic(this.platform.Characteristic.ColorTemperature)
        .onSet(this.setColorTemperature.bind(this))
        .onGet(this.getColorTemperature.bind(this));
    }

    this.ledState.LightCapability = lc;
  }
}
