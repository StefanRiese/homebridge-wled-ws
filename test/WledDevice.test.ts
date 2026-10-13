jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledDevice } from '../src/WledDevice';
import { LightCapability, WledPreset } from '../src/WledController';
import {
  clients,
  createAccessory,
  FakeClient,
  flushPromises,
  mockLogger,
} from './helpers/fakeWled';

const state = (presetId: number, playlistId: number, on = true) => ({
  on,
  presetId,
  playlistId,
});

describe('WledDevice', () => {
  let device: WledDevice;
  let client: FakeClient;
  let changes: Array<Pick<WledPreset, 'id' | 'on'>>;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clients.length = 0;
    const controller = createAccessory().context.device;
    controller.presets = 'Preset1,Preset2,Playlist';
    device = new WledDevice(controller as any, mockLogger as any, true);
    changes = [];
    device.on('presetChanged', (preset) => changes.push({ id: preset.id, on: preset.on }));
    device.connect(false);
    client = clients[0];
    client.presets = {
      '1': { name: 'Preset1', segments: [] },
      '2': { name: 'Preset2', segments: [] },
      '3': { name: 'Unused', segments: [] },
      '5': { name: 'Playlist' }, // no segments -> playlist
    };
    client.emit('open');
    await flushPromises();
  });

  afterEach(() => {
    device.disconnect();
    jest.useRealTimers();
  });

  describe('connection', () => {
    it('emits connected when the websocket opens', () => {
      const listener = jest.fn();
      device.on('connected', listener);
      clients[0].emit('open');
      expect(listener).toHaveBeenCalled();
      expect(device.connected).toBe(true);
    });

    it('emits disconnected and reconnects after the websocket closes', () => {
      const listener = jest.fn();
      device.on('disconnected', listener);

      client.emit('close');

      expect(listener).toHaveBeenCalled();
      expect(device.connected).toBe(false);
      jest.advanceTimersByTime(10000);
      expect(clients).toHaveLength(2);
    });

    it('emits disconnected and reconnects after an error', () => {
      const listener = jest.fn();
      device.on('disconnected', listener);

      client.emit('error', new Error('boom'));

      expect(listener).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Controller %s communication error: boom',
        'TestDevice',
      );
      jest.advanceTimersByTime(10000);
      expect(clients).toHaveLength(2);
    });

    it('does not reconnect after disconnect()', () => {
      device.disconnect();
      client.emit('close');
      jest.advanceTimersByTime(10000);
      expect(clients).toHaveLength(1);
    });
  });

  describe('presets', () => {
    it('emits only the configured presets available on the controller', () => {
      const listener = jest.fn();
      device.on('presets', listener);

      client.emit('update:presets');

      const presets = listener.mock.calls[0][0] as WledPreset[];
      expect(presets.map((p) => [p.id, p.name, p.isPlaylist])).toEqual([
        ['1', 'Preset1', false],
        ['2', 'Preset2', false],
        ['5', 'Playlist', true],
      ]);
      expect(device.presets).toBe(presets);
    });

    it('logs configured presets missing on the controller', () => {
      delete client.presets['2'];
      client.emit('update:presets');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Configured preset(s) %s not supported by controller %s',
        ['Preset2'],
        'TestDevice',
      );
    });

    it('switches the active preset when the controller selects another one', () => {
      client.emit('update:presets');

      client.state = state(1, -1);
      client.emit('update:state');
      expect(changes).toEqual([{ id: '1', on: true }]);

      changes.length = 0;
      client.state = state(2, -1);
      client.emit('update:state');
      expect(changes).toEqual([
        { id: '1', on: false },
        { id: '2', on: true },
      ]);
    });

    it('follows the controller on state for the newly selected preset', () => {
      client.emit('update:presets');
      client.state = state(1, -1, false);
      client.emit('update:state');
      expect(changes).toEqual([{ id: '1', on: false }]);
    });

    it('immediately switches a started playlist off again', () => {
      client.emit('update:presets');
      client.state = state(-1, 5);
      client.emit('update:state');
      expect(changes).toEqual([{ id: '5', on: false }]);
    });

    it('keeps the preset state when the preset list is refreshed', () => {
      client.emit('update:presets');
      client.state = state(1, -1);
      client.emit('update:state');

      client.emit('update:presets');

      expect(device.presets.find((p) => p.id === '1')?.on).toBe(true);
    });

    it('activates a preset or turns the controller off', () => {
      client.emit('update:presets');
      const preset = device.presets[0];

      device.setPreset(preset, true);
      expect(preset.on).toBe(true);
      expect(client.setPreset).toHaveBeenCalledWith('1');

      device.setPreset(preset, false);
      expect(preset.on).toBe(false);
      expect(client.turnOff).toHaveBeenCalled();
    });
  });

  describe('info', () => {
    const leds = (lightCapabilities?: number) => ({
      brand: 'WLED',
      product: 'FOSS',
      version: '0.15.0',
      mac: 'aabbccddeeff',
      leds: lightCapabilities === undefined ? {} : { lightCapabilities },
    });

    it('emits the device info only once', () => {
      const listener = jest.fn();
      device.on('info', listener);
      client.info = leds(LightCapability.RGBWCCT);

      client.emit('update:info');
      client.emit('update:info');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        brand: 'WLED',
        product: 'FOSS',
        version: '0.15.0',
        mac: 'aabbccddeeff',
        lightCapability: LightCapability.RGBWCCT,
      });
    });

    it('falls back to RGB for firmware without light capabilities', () => {
      const listener = jest.fn();
      device.on('info', listener);
      client.info = leds();

      client.emit('update:info');

      expect(listener.mock.calls[0][0].lightCapability).toBe(LightCapability.RGB);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Please update controller %s firmware to latest one!',
        'TestDevice',
      );
    });
  });

  describe('live mode', () => {
    it('allows live data when enabled', () => {
      device.setLive(true);
      expect(client.allowLiveData).toHaveBeenCalled();
    });

    it('ignores live data according to resetRealTimeModeAfterStream', () => {
      device.controller.resetRealTimeModeAfterStream = true;
      device.setLive(false);
      expect(client.ignoreLiveData).toHaveBeenCalledWith(false);

      device.controller.resetRealTimeModeAfterStream = false;
      device.setLive(false);
      expect(client.ignoreLiveData).toHaveBeenCalledWith(true);
    });
  });
});
