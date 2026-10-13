jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledDevice, WledDeviceInfo } from '../src/WledDevice';
import { matterTiming, WledMatterAccessory } from '../src/WledMatterAccessory';
import { levelToBrightness } from '../src/WledUtils';
import { LightCapability, WledPreset } from '../src/WledController';
import { clients, createAccessory, flushPromises, mockLogger } from './helpers/fakeWled';
import { createMatterApi, FakeMatterApi, FakeMatterOptions, registeredAccessory } from './helpers/fakeMatter';

const UUID = 'uuid-matter:127.0.0.1';

const info = (lightCapability: LightCapability, version = '0.15.0'): WledDeviceInfo => ({
  brand: 'WLED',
  product: 'FOSS',
  version,
  mac: 'aabbccddeeff',
  lightCapability,
});

const preset = (id: string, name: string, on = false, isPlaylist = false): WledPreset =>
  ({ id, name, on, isPlaylist });

const wledState = (overrides: Record<string, unknown> = {}) => ({
  on: true,
  brightness: 255,
  liveDataOverride: 0,
  presetId: -1,
  playlistId: -1,
  segments: [{ colors: [[255, 0, 0], [0, 0, 0], [0, 0, 0]], cct: 127 }],
  ...overrides,
});

const cachedAccessory = (context: Record<string, unknown>) => ({
  UUID,
  context: { address: '127.0.0.1', presets: [], live: false, ...context },
});

describe('WledMatterAccessory', () => {
  let api: FakeMatterApi;
  let device: WledDevice;
  let matterAccessory: WledMatterAccessory;
  const timing = { ...matterTiming };

  const setup = (controller: Record<string, unknown> = {}, options?: FakeMatterOptions) => {
    api = createMatterApi(options);
    device = new WledDevice(
      { ...createAccessory().context.device, presets: '', ...controller } as any,
      mockLogger as any,
      false,
    );
  };

  const create = (cached?: unknown) => {
    matterAccessory = new WledMatterAccessory(api as any, mockLogger as any, device, true, cached as any);
    return matterAccessory;
  };

  // let timers and the operation queue of the accessory run
  const settle = async (millis = 0) => {
    await new Promise((resolve) => setTimeout(resolve, millis));
    await matterAccessory.settled();
  };

  const connect = async () => {
    device.connect(false);
    clients[clients.length - 1].emit('open');
    await flushPromises();
    await settle();
  };

  const emitInfo = async (lc: LightCapability, version?: string) => {
    device.emit('info', info(lc, version));
    await settle();
  };

  const emitPresets = async (presets: WledPreset[]) => {
    device['presetList'] = presets;
    device.emit('presets', presets);
    await settle();
  };

  const emitState = async (overrides: Record<string, unknown> = {}) => {
    device.emit('state', wledState(overrides) as any);
    await settle();
  };

  const handlers = () => registeredAccessory(api, -1).handlers;
  const part = (id: string) => registeredAccessory(api, -1).parts.find((p: any) => p.id === id);
  const client = () => clients[clients.length - 1];

  beforeEach(() => {
    jest.clearAllMocks();
    clients.length = 0;
    Object.assign(matterTiming, {
      registrationTimeout: 2000,
      registrationPoll: 5,
      registrationRetry: 200,
      unregistrationSettle: 10,
      startupWait: 100,
      presetsWait: 100,
    });
    setup();
  });

  afterEach(() => {
    device.disconnect();
  });

  afterAll(() => {
    Object.assign(matterTiming, timing);
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
      expect(accessory.UUID).toBe(UUID);
      expect(accessory.deviceType.name).toBe(deviceType);
      expect(accessory.context).toEqual({
        address: '127.0.0.1', lightCapability: lc, presets: [], live: false, info: info(lc),
      });
      expect(accessory.serialNumber).toBe('aabbccddeeff');
      expect(accessory.firmwareRevision).toBe('0.15.0');
      expect(accessory.parts).toBeUndefined();
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

      setup();
      create();
      await emitInfo(LightCapability.WCCT);
      const wcct = registeredAccessory(api).clusters.colorControl;
      expect(wcct).toHaveProperty('colorTemperatureMireds', 321);
      // mandatory with the ColorTemperature feature, matter.js rejects the endpoint without it
      expect(wcct).toHaveProperty('coupleColorTempToLevelMinMireds', 140);
      expect(wcct).not.toHaveProperty('currentHue');
    });

    it('exposes presets, playlists and the live mode switch as parts', async () => {
      setup({ presets: 'Preset1,Playlist', showRealTimeModeButton: true });
      create();
      await emitInfo(LightCapability.RGB);
      await emitPresets([preset('1', 'Preset1'), preset('5', 'Playlist', false, true)]);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      const accessory = registeredAccessory(api);
      expect(accessory.parts.map((p: any) => [p.id, p.displayName, p.deviceType.name])).toEqual([
        ['preset-1', 'Preset1', 'OnOffOutlet'],
        ['preset-5', 'Playlist', 'OnOffOutlet'],
        ['live', 'Ambilight', 'OnOffOutlet'],
      ]);
      expect(accessory.context.presets).toEqual([
        { id: '1', name: 'Preset1', isPlaylist: false },
        { id: '5', name: 'Playlist', isPlaylist: true },
      ]);
      expect(accessory.context.live).toBe(true);
    });

    it('waits for the presets before registering', async () => {
      setup({ presets: 'Preset1' });
      create();
      await emitInfo(LightCapability.RGB);
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();

      await emitPresets([preset('1', 'Preset1')]);
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });

    it('registers without preset parts if the presets do not arrive in time', async () => {
      setup({ presets: 'Preset1' });
      create();
      await emitInfo(LightCapability.RGB);
      await settle(150);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(registeredAccessory(api).parts).toBeUndefined();
    });

    it('registers a cached accessory as cached if the controller stays offline', async () => {
      create(cachedAccessory({ lightCapability: LightCapability.RGB, presets: [{ id: '1', name: 'Preset1' }] }));
      await settle(150);

      const accessory = registeredAccessory(api);
      expect(accessory.UUID).toBe(UUID);
      expect(accessory.deviceType.name).toBe('ExtendedColorLight');
      expect(accessory.parts.map((p: any) => p.id)).toEqual(['preset-1']);
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        UUID, 'bridgedDeviceBasicInformation', { reachable: false },
      );
    });

    it('registers a cached accessory with an unchanged structure once', async () => {
      create(cachedAccessory({ lightCapability: LightCapability.RGB, info: info(1) }));
      await emitInfo(LightCapability.RGB);
      await settle(150);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('accepts cached contexts without parts information', async () => {
      create({ UUID, context: { address: '127.0.0.1', lightCapability: LightCapability.RGB } });
      await emitInfo(LightCapability.RGB);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('registers a cached accessory with the current metadata', async () => {
      create(cachedAccessory({ lightCapability: LightCapability.RGB, info: info(1) }));
      await emitInfo(LightCapability.RGB, '0.16.0');

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(registeredAccessory(api).firmwareRevision).toBe('0.16.0');
      expect(registeredAccessory(api).context.info.version).toBe('0.16.0');
    });

    it('re-registers a cached accessory with a changed structure under the same UUID', async () => {
      create(cachedAccessory({ lightCapability: LightCapability.RGB }));
      await emitInfo(LightCapability.RGBWCCT);

      expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
      const unregistered = api.matter.unregisterPlatformAccessories.mock.calls[0][2][0];
      expect(unregistered.UUID).toBe(UUID);
      expect(unregistered.deviceType.name).toBe('ExtendedColorLight');
      expect(registeredAccessory(api, -1).UUID).toBe(UUID);
      expect(registeredAccessory(api, -1).handlers.colorControl).toHaveProperty('moveToColorTemperatureLogic');
      expect(api.matter.state[UUID]?.colorControl).toHaveProperty('colorTemperatureMireds');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('re-registers when a preset disappears from the controller', async () => {
      setup({ presets: 'Preset1,Preset2' });
      create();
      await emitInfo(LightCapability.RGB);
      await emitPresets([preset('1', 'Preset1'), preset('2', 'Preset2')]);

      await emitPresets([preset('1', 'Preset1')]);

      expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(registeredAccessory(api, -1).parts.map((p: any) => p.id)).toEqual(['preset-1']);
      expect(api.matter.state[`${UUID}#preset-2`]).toBeUndefined();
      expect(api.matter.state[`${UUID}#preset-1`]).toBeDefined();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('does not re-register when the same presets are received again', async () => {
      setup({ presets: 'Preset1' });
      create();
      await emitInfo(LightCapability.RGB);
      await emitPresets([preset('1', 'Preset1')]);
      await emitPresets([preset('1', 'Preset1', true)]);

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('repeats a registration dropped while the old accessory is still being removed', async () => {
      // Homebridge closes the endpoint first and frees the UUID later
      setup({ presets: 'Preset1,Preset2' }, { forgetDelay: 300 });
      create();
      await emitInfo(LightCapability.RGB);
      await emitPresets([preset('1', 'Preset1'), preset('2', 'Preset2')]);

      await emitPresets([preset('1', 'Preset1')]);

      expect(api.matter.dropped).toContain(UUID);
      expect(api.matter.registerPlatformAccessories.mock.calls.length).toBeGreaterThan(2);
      expect(registeredAccessory(api, -1).parts.map((p: any) => p.id)).toEqual(['preset-1']);
      expect(api.matter.state[`${UUID}#preset-1`]).toBeDefined();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('commands', () => {
    beforeEach(async () => {
      setup({ presets: 'Preset1,Preset2', showRealTimeModeButton: true });
      create();
      await connect();
      await emitInfo(LightCapability.RGBWCCT);
      await emitPresets([preset('1', 'Preset1'), preset('2', 'Preset2')]);
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
      const [[[r, g, b]]] = client().setColor.mock.calls;
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

    it('activates and deactivates presets', async () => {
      await part('preset-2').handlers.onOff.on();
      expect(client().setPreset).toHaveBeenCalledWith('2');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Matter: set controller %s preset %s (%s) to: %s',
        device.controller.name,
        '2',
        expect.any(String),
        'On',
      );
      await part('preset-2').handlers.onOff.off();
      expect(client().turnOff).toHaveBeenCalled();
    });

    it('toggles a preset', async () => {
      await part('preset-1').handlers.onOff.toggle();
      expect(client().setPreset).toHaveBeenCalledWith('1');
    });

    it('switches the live mode', async () => {
      await part('live').handlers.onOff.on();
      expect(client().allowLiveData).toHaveBeenCalled();
      await part('live').handlers.onOff.off();
      expect(client().ignoreLiveData).toHaveBeenCalled();
    });

    it('rejects commands while the controller is not connected', async () => {
      device['connectionEstablished'] = false;
      await expect(handlers().onOff.on()).rejects.toThrow('No connection to controller TestDevice');
      await expect(part('preset-1').handlers.onOff.on()).rejects.toThrow('No connection');
      expect(client().turnOn).not.toHaveBeenCalled();
      expect(client().setPreset).not.toHaveBeenCalled();
    });

    it('rejects a preset which is not available anymore', async () => {
      device['presetList'] = [];
      await expect(part('preset-1').handlers.onOff.on()).rejects.toThrow('Preset 1 is not available');
    });
  });

  describe('state updates', () => {
    const pushes = (cluster: string, partId?: string) =>
      api.matter.updateAccessoryState.mock.calls
        .filter(([, c, , p]) => c === cluster && p === partId)
        .map(([, , attributes]) => attributes);

    beforeEach(async () => {
      setup({ presets: 'Preset1,Preset2', showRealTimeModeButton: true });
      create();
      await connect();
      await emitInfo(LightCapability.RGBWCCT);
      await emitPresets([preset('1', 'Preset1', true), preset('2', 'Preset2')]);
      api.matter.updateAccessoryState.mockClear();
    });

    it('pushes the active preset after the registration', () => {
      expect(api.matter.state[`${UUID}#preset-1`].onOff).toEqual({ onOff: true });
      expect(api.matter.state[`${UUID}#preset-2`].onOff).toEqual({ onOff: false });
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
      const [[[r, g, b]]] = client().setColor.mock.calls;

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

    it('pushes preset changes of the controller to the parts', async () => {
      device.emit('presetChanged', preset('1', 'Preset1', false));
      device.emit('presetChanged', preset('2', 'Preset2', true));
      await settle();

      expect(pushes('onOff', 'preset-1')).toEqual([{ onOff: false }]);
      expect(pushes('onOff', 'preset-2')).toEqual([{ onOff: true }]);
    });

    it('pushes the live mode to its part', async () => {
      await emitState({ liveDataOverride: 0 });
      await emitState({ liveDataOverride: 2 });

      expect(pushes('onOff', 'live')).toEqual([{ onOff: true }, { onOff: false }]);
    });

    it('ignores changes of presets which are not exposed', async () => {
      device.emit('presetChanged', preset('9', 'Unknown', true));
      await settle();
      expect(pushes('onOff', 'preset-9')).toEqual([]);
    });

    it('reports reachability', async () => {
      client().emit('close');
      await settle();
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

  it('pushes state changes of a restored accessory against its cached Matter state', async () => {
    api.matter.state[UUID] = { onOff: { onOff: true } };
    create(cachedAccessory({ lightCapability: LightCapability.OnOff }));
    await settle(150);
    api.matter.updateAccessoryState.mockClear();

    await emitState({ on: false });

    expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(UUID, 'onOff', { onOff: false });
  });
});
