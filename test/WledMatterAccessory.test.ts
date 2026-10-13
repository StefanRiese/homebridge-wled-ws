jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledDevice, WledDeviceInfo } from '../src/WledDevice';
import { WledMatterAccessory } from '../src/WledMatterAccessory';
import { levelToBrightness } from '../src/WledUtils';
import { LightCapability } from '../src/WledController';
import { clients, createAccessory, flushPromises, mockLogger } from './helpers/fakeWled';
import { createMatterApi, FakeMatterApi, registeredAccessory } from './helpers/fakeMatter';

const uuid = (lc: LightCapability) => `uuid-matter:127.0.0.1:${lc}`;
const UUID = uuid(LightCapability.RGBWCCT);

const info = (lightCapability: LightCapability, version = '0.15.0'): WledDeviceInfo => ({
  brand: 'WLED',
  product: 'FOSS',
  version,
  mac: 'aabbccddeeff',
  lightCapability,
});

const wledState = (overrides: Record<string, unknown> = {}) => ({
  on: true,
  brightness: 255,
  liveDataOverride: 0,
  presetId: -1,
  playlistId: -1,
  segments: [{ colors: [[255, 0, 0], [0, 0, 0], [0, 0, 0]], cct: 127 }],
  ...overrides,
});

describe('WledMatterAccessory', () => {
  let api: FakeMatterApi;
  let device: WledDevice;
  let matterAccessory: WledMatterAccessory;

  const create = (cached?: unknown) => {
    matterAccessory = new WledMatterAccessory(
      api as any,
      mockLogger as any,
      device,
      true,
      cached as any,
    );
    return matterAccessory;
  };

  const connect = async () => {
    device.connect(false);
    clients[clients.length - 1].emit('open');
    await flushPromises();
    await matterAccessory.settled();
  };

  const emitInfo = async (lc: LightCapability, version?: string) => {
    device.emit('info', info(lc, version));
    await matterAccessory.settled();
  };

  const emitState = async (overrides: Record<string, unknown> = {}) => {
    device.emit('state', wledState(overrides) as any);
    await matterAccessory.settled();
  };

  const handlers = () => registeredAccessory(api).handlers;
  const client = () => clients[clients.length - 1];

  beforeEach(() => {
    jest.clearAllMocks();
    clients.length = 0;
    api = createMatterApi();
    device = new WledDevice(createAccessory().context.device as any, mockLogger as any, false);
  });

  afterEach(() => {
    device.disconnect();
  });

  describe('registration', () => {
    it.each([
      [LightCapability.OnOff, 'OnOffLight', undefined],
      [LightCapability.White, 'DimmableLight', undefined],
      [LightCapability.WCCT, 'ColorTemperatureLight', ['moveToColorTemperatureLogic', 'stopAllColorMovement']],
      [LightCapability.RGB, 'ExtendedColorLight',
        ['moveToHueAndSaturationLogic', 'moveToHueLogic', 'moveToSaturationLogic', 'moveToColorLogic',
          'stopAllColorMovement']],
      [LightCapability.RGBW, 'ExtendedColorLight',
        ['moveToHueAndSaturationLogic', 'moveToHueLogic', 'moveToSaturationLogic', 'moveToColorLogic',
          'stopAllColorMovement']],
      [LightCapability.RGBWCCT, 'ExtendedColorLight',
        ['moveToHueAndSaturationLogic', 'moveToHueLogic', 'moveToSaturationLogic', 'moveToColorLogic',
          'moveToColorTemperatureLogic', 'stopAllColorMovement']],
    ])('registers capability %s as %s with color handlers %j', async (lc, deviceType, colorHandlers) => {
      create();
      await emitInfo(lc);

      const accessory = registeredAccessory(api);
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledWith(
        'homebridge-wled-ws', 'wled-ws', [accessory],
      );
      expect(accessory.UUID).toBe(uuid(lc));
      expect(accessory.deviceType.name).toBe(deviceType);
      expect(accessory.context).toEqual({ address: '127.0.0.1', lightCapability: lc, info: info(lc) });
      expect(accessory.serialNumber).toBe('aabbccddeeff');
      expect(accessory.firmwareRevision).toBe('0.15.0');
      expect(Object.keys(accessory.handlers.colorControl ?? {})).toEqual(colorHandlers ?? []);
      expect(accessory.handlers.levelControl !== undefined).toBe(lc !== LightCapability.OnOff);
    });

    it('only declares color attributes of supported features', async () => {
      create();
      await emitInfo(LightCapability.RGB);
      const rgb = registeredAccessory(api).clusters.colorControl;
      expect(rgb).toHaveProperty('currentHue');
      expect(rgb).toHaveProperty('currentX');
      expect(rgb).not.toHaveProperty('colorTemperatureMireds');

      api = createMatterApi();
      create();
      await emitInfo(LightCapability.WCCT);
      const wcct = registeredAccessory(api).clusters.colorControl;
      expect(wcct).toHaveProperty('colorTemperatureMireds', 321);
      // mandatory with the ColorTemperature feature, matter.js rejects the endpoint without it
      expect(wcct).toHaveProperty('coupleColorTempToLevelMinMireds', 140);
      expect(wcct).not.toHaveProperty('currentHue');
    });

    it('registers a cached accessory before the controller is connected', async () => {
      create({ UUID: uuid(1), context: { address: '127.0.0.1', lightCapability: LightCapability.RGB } });
      await matterAccessory.settled();

      expect(registeredAccessory(api).deviceType.name).toBe('ExtendedColorLight');
      expect(registeredAccessory(api).UUID).toBe(uuid(1));
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        uuid(1), 'bridgedDeviceBasicInformation', { reachable: false },
      );
    });

    it('does not register a cached accessory twice once the info arrives', async () => {
      create({ UUID: uuid(1), context: { address: '127.0.0.1', lightCapability: LightCapability.RGB, info: info(1) } });
      await emitInfo(LightCapability.RGB);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.updatePlatformAccessories).not.toHaveBeenCalled();
    });

    it('updates the metadata when the firmware changed', async () => {
      create({ UUID: uuid(1), context: { address: '127.0.0.1', lightCapability: LightCapability.RGB, info: info(1) } });
      await emitInfo(LightCapability.RGB, '0.16.0');

      expect(api.matter.updatePlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.updatePlatformAccessories.mock.calls[0][0][0].firmwareRevision).toBe('0.16.0');
    });

    it('re-registers the accessory when the light capabilities changed', async () => {
      create({ UUID: uuid(1), context: { address: '127.0.0.1', lightCapability: LightCapability.RGB } });
      await emitInfo(LightCapability.RGBWCCT);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.unregisterPlatformAccessories.mock.calls[0][2][0].UUID).toBe(uuid(1));
      expect(api.matter.state[uuid(1)]).toBeUndefined();
      expect(matterAccessory.accessoryUuid).toBe(uuid(7));
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
      expect(registeredAccessory(api, 1).handlers.colorControl).toHaveProperty('moveToColorTemperatureLogic');
      // the new accessory is in place once the old one is gone
      expect(api.matter.state[UUID]?.colorControl).toHaveProperty('colorTemperatureMireds');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('commands', () => {
    beforeEach(async () => {
      create();
      await connect();
      await emitInfo(LightCapability.RGBWCCT);
    });

    it('turns the light on and off', async () => {
      await handlers().onOff.on();
      expect(client().turnOn).toHaveBeenCalled();
      await handlers().onOff.off();
      expect(client().turnOff).toHaveBeenCalled();
    });

    it('toggles based on the controller state', async () => {
      await emitState({ on: true });
      await handlers().onOff.toggle();
      expect(client().turnOff).toHaveBeenCalled();
    });

    it('sets the brightness', async () => {
      await handlers().levelControl.moveToLevel({ level: 127 });
      expect(client().setBrightness).toHaveBeenCalledWith(128);
      expect(client().turnOn).not.toHaveBeenCalled();
    });

    it('turns the light on with a level above the minimum', async () => {
      await handlers().levelControl.moveToLevelWithOnOff({ level: 254 });
      expect(client().turnOn).toHaveBeenCalled();
      expect(client().setBrightness).toHaveBeenCalledWith(255);
    });

    it('turns the light off with the minimum level', async () => {
      await handlers().levelControl.moveToLevelWithOnOff({ level: 1 });
      expect(client().turnOff).toHaveBeenCalled();
      expect(client().setBrightness).not.toHaveBeenCalled();
    });

    it('sets hue and saturation', async () => {
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 85, saturation: 254 });
      expect(client().setColor).toHaveBeenCalledWith([0, 255, 2]);
    });

    it('keeps the saturation when only the hue changes', async () => {
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 0, saturation: 127 });
      await handlers().colorControl.moveToHueLogic({ targetHue: 169 });
      expect(client().setColor).toHaveBeenLastCalledWith([128, 129, 255]);
    });

    it('sets an xy color', async () => {
      await handlers().colorControl.moveToColorLogic({ targetX: 41943, targetY: 21627 }); // sRGB red
      const [[r, g, b]] = client().setColor.mock.calls[0];
      expect(r).toBe(255);
      expect(g).toBeLessThanOrEqual(2);
      expect(b).toBeLessThanOrEqual(2);
    });

    it('sets the color temperature on the white channel', async () => {
      await handlers().colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 250 });
      expect(client().setColor).toHaveBeenCalledWith([0, 0, 0, 255]);
      expect(client().setCCT).toHaveBeenCalledWith(177);
    });

    it('provides every handler matter.js calls internally', () => {
      expect(Object.keys(handlers().levelControl).sort()).toEqual(
        ['move', 'moveToLevel', 'moveToLevelWithOnOff', 'step', 'stop'],
      );
      expect(handlers().colorControl).toHaveProperty('stopAllColorMovement');
    });

    it('never fails internal calls, even without a connection', async () => {
      device['connectionEstablished'] = false;
      await expect(handlers().colorControl.stopAllColorMovement()).resolves.toBeUndefined();
      await expect(handlers().levelControl.move({})).resolves.toBeUndefined();
      await expect(handlers().levelControl.stop({})).resolves.toBeUndefined();
    });

    it('steps the level up and down', async () => {
      await handlers().levelControl.moveToLevel({ level: 100 });
      await handlers().levelControl.step({ stepMode: 0, stepSize: 50 });
      expect(client().setBrightness).toHaveBeenLastCalledWith(levelToBrightness(150));
      await handlers().levelControl.step({ stepMode: 1, stepSize: 200 });
      expect(client().setBrightness).toHaveBeenLastCalledWith(levelToBrightness(1));
    });

    it('sends a hue/saturation command only once although matter.js runs its steps too', async () => {
      // matter.js: moveToHueAndSaturation -> moveToHueLogic + moveToSaturationLogic
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 85, saturation: 254 });
      await handlers().colorControl.moveToHueLogic({ targetHue: 85 });
      await handlers().colorControl.moveToSaturationLogic({ targetSaturation: 254 });
      expect(client().setColor).toHaveBeenCalledTimes(1);
    });

    it('sends the same color again after a while', async () => {
      jest.useFakeTimers({ now: Date.now(), doNotFake: ['setImmediate'] });
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 85, saturation: 254 });
      jest.advanceTimersByTime(1500);
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 85, saturation: 254 });
      jest.useRealTimers();
      expect(client().setColor).toHaveBeenCalledTimes(2);
    });

    it('rejects commands while the controller is not connected', async () => {
      device['connectionEstablished'] = false;
      await expect(handlers().onOff.on()).rejects.toThrow('No connection to controller TestDevice');
      expect(client().turnOn).not.toHaveBeenCalled();
    });
  });

  describe('state updates', () => {
    const pushes = (cluster: string) =>
      api.matter.updateAccessoryState.mock.calls
        .filter(([, c]) => c === cluster)
        .map(([, , attributes]) => attributes);

    beforeEach(async () => {
      create();
      await connect();
      await emitInfo(LightCapability.RGBWCCT);
      api.matter.updateAccessoryState.mockClear();
    });

    it('pushes the controller state', async () => {
      await emitState({ on: true, brightness: 128 });

      expect(pushes('onOff')).toEqual([{ onOff: true }]);
      expect(pushes('levelControl')).toEqual([{ currentLevel: 127 }]);
      expect(pushes('colorControl')[0]).toMatchObject({ currentSaturation: 254 });
    });

    it('only pushes changed attributes', async () => {
      await emitState();
      api.matter.updateAccessoryState.mockClear();

      await emitState({ brightness: 100 });

      expect(api.matter.updateAccessoryState.mock.calls).toEqual([
        [UUID, 'levelControl', { currentLevel: 100 }],
      ]);
    });

    it('does not echo a command back with rounding noise', async () => {
      await handlers().colorControl.moveToHueAndSaturationLogic({ hue: 100, saturation: 200 });
      const [[r, g, b]] = client().setColor.mock.calls;

      await emitState({ segments: [{ colors: [[r, g, b]], cct: 127 }] });

      const hs = pushes('colorControl').filter((p) => 'currentHue' in p || 'currentSaturation' in p);
      expect(hs).toEqual([]);
    });

    it('switches to color temperature mode for white only', async () => {
      await emitState({ segments: [{ colors: [[0, 0, 0, 255]], cct: 177 }] });

      expect(pushes('colorControl')).toContainEqual(
        expect.objectContaining({ colorTemperatureMireds: 250, colorMode: 2, enhancedColorMode: 2 }),
      );
    });

    it('pushes state changes of a restored accessory against its cached Matter state', async () => {
      api = createMatterApi();
      api.matter.state[uuid(0)] = { onOff: { onOff: true } };
      create({ UUID: uuid(0), context: { address: '127.0.0.1', lightCapability: LightCapability.OnOff } });
      await matterAccessory.settled();

      await emitState({ on: false });

      expect(pushes('onOff')).toEqual([{ onOff: false }]);
    });

    it('reports reachability', async () => {
      client().emit('close');
      await matterAccessory.settled();
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        UUID, 'bridgedDeviceBasicInformation', { reachable: false },
      );

      await connect();
      expect(api.matter.updateAccessoryState).toHaveBeenLastCalledWith(
        UUID, 'bridgedDeviceBasicInformation', { reachable: true },
      );
    });

    it('logs failed Matter updates instead of throwing', async () => {
      api.matter.updateAccessoryState.mockRejectedValueOnce(new Error('not registered'));
      await emitState({ on: false });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Matter update for controller %s failed: %s',
        'TestDevice',
        'not registered',
      );
    });
  });
});
