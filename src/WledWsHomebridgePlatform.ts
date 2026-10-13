import {
  API,
  DynamicPlatformPlugin,
  Logger,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WledWsPlatformAccessory } from './WledWsPlatformAccessory';
import { WledController } from './WledController';
import { WledDevice } from './WledDevice';
import { WledMatterAccessory } from './WledMatterAccessory';

/**
 * HomebridgePlatform
 * This class is the main constructor for the plugin, here we parse
 * the user config and discover/register accessories with Homebridge.
 */
export class WledWsHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly matterAccessories: MatterAccessory[] = [];

  // holds a list of controller
  private controllerMap = new Map();
  private accessoryMap = new Map();
  private deviceMap = new Map<string, WledDevice>();
  private matterAccessoryMap = new Map<string, WledMatterAccessory>();
  private claimedMatterAccessories = new Set<MatterAccessory>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // Check if at least one controller is configured using plugin settings or config.json
    // For the "homebridge verified" badge we must not continue if the configuration is missing
    if (!this.config.controllers) {
      log.error('Please configure at least one controller');
      return;
    }

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      log.debug('Executed shutdown callback');
      this.disconnectDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This function is invoked when homebridge restores cached Matter accessories from disk at startup.
   */
  configureMatterAccessory(accessory: MatterAccessory) {
    this.log.info('Loading Matter accessory from cache:', accessory.displayName);
    this.matterAccessories.push(accessory);
  }

  /**
   * Matter is used if the bridge runs Matter (Homebridge 2.x) and it is enabled in the plugin config
   */
  get matterEnabled(): boolean {
    return this.config.enableMatter === true && this.api.isMatterEnabled?.() === true;
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // Get configured controllers from config and create corresponding accessories
    // In case of configuration changes, the following scheme will apply:
    // Configured, but not cached -> Add
    // Configured and cached -> Restore
    // Not configured, but cached -> Remove
    for (const id in this.config.controllers) {
      const controller = <WledController>this.config.controllers[id];
      this.log.info(
        'Loading configuration for controller %s at address %s',
        controller.name,
        controller.address,
      );

      // generate a unique id for the accessory genrated from address and check
      // if another controller is already registered under the same address
      const uuid = this.api.hap.uuid.generate(controller.address);
      if (this.controllerMap.has(controller.address)) {
        const existingController = <WledController>(
          this.controllerMap.get(controller.address)
        );
        this.log.error(
          'Controller %s is already configured at address %s',
          existingController.name,
          controller.address,
        );
      } else {
        this.controllerMap.set(controller.address, controller);

        // see if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above
        const existingAccessory = this.accessories.find(
          (accessory) => accessory.UUID === uuid,
        );

        if (existingAccessory) {
          // the accessory already exists
          this.log.info(
            'Restoring existing accessory from cache:',
            existingAccessory.displayName,
          );

          // always update the accessory.context
          existingAccessory.context.device = controller;
          this.api.updatePlatformAccessories([existingAccessory]);

          // create the accessory handler for the restored accessory
          // this is imported from `platformAccessory.ts`
          this.createAccessoryHandler(uuid, controller, existingAccessory);

          // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
          // remove platform accessories when no longer present
          // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
        } else {
          // the accessory does not yet exist, so we need to create it
          this.log.info('Adding new accessory:', controller.name);

          // create a new accessory
          const accessory = new this.api.platformAccessory(
            controller.name,
            uuid,
          );

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = controller;

          // create the accessory handler for the newly create accessory
          // this is imported from `platformAccessory.ts`
          this.createAccessoryHandler(uuid, controller, accessory);

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
            accessory,
          ]);
        }
      }
    }

    // find cached but not configured accessories and unregister them
    const accessoriesToBeRemoved: PlatformAccessory[] = [];
    for (const cachedAccessory of this.accessories) {
      if (!this.controllerMap.has(cachedAccessory.context.device.address)) {
        this.log.info(
          'Removing accessory %s',
          cachedAccessory.context.device.name,
        );
        accessoriesToBeRemoved.push(cachedAccessory);
      }
    }

    if (accessoriesToBeRemoved.length > 0) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        accessoriesToBeRemoved,
      );
    }

    this.removeOrphanedMatterAccessories();
  }

  /**
   * Removes cached Matter accessories of controllers which are not configured anymore,
   * or all of them if Matter was disabled in the plugin config
   */
  removeOrphanedMatterAccessories() {
    // the cached accessory of a configured controller is passed to its WledMatterAccessory
    const orphans = this.matterAccessories.filter(
      (accessory) => !this.claimedMatterAccessories.has(accessory),
    );
    if (orphans.length === 0 || !this.api.matter) {
      return;
    }

    for (const accessory of orphans) {
      this.log.info('Removing Matter accessory %s', accessory.displayName);
    }
    this.api.matter
      .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphans)
      .catch((error) => {
        this.log.error(
          'Error removing Matter accessories: %s',
          error instanceof Error ? error.message : error,
        );
      });
  }

  /**
   * Creates the connection to the controller and the HomeKit handler for its accessory,
   * then connects the controller
   */
  createAccessoryHandler(
    uuid: string,
    controller: WledController,
    accessory: PlatformAccessory,
  ) {
    const device = new WledDevice(controller, this.log, this.config.logging);
    this.deviceMap.set(uuid, device);
    this.accessoryMap.set(
      uuid,
      new WledWsPlatformAccessory(
        this,
        this.log,
        accessory,
        device,
        this.config.logging,
      ),
    );

    if (this.matterEnabled) {
      const cached = this.matterAccessories.find(
        (accessory) => (accessory.context as { address?: string })?.address === controller.address,
      );
      if (cached) {
        this.claimedMatterAccessories.add(cached);
      }
      this.matterAccessoryMap.set(
        controller.address,
        new WledMatterAccessory(this.api, this.log, device, this.config.logging, cached),
      );
    }

    // Connect the controller with Reconnect-Flag set to false
    device.connect(false);
  }

  /**
   * On shutdown close all existing connections
   */
  disconnectDevices() {
    this.log.info('Shutdown - disconnecting all accessories');
    for (const device of this.deviceMap.values()) {
      device.disconnect();
    }
  }
}
