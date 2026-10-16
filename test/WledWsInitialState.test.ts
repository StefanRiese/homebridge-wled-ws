jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledWsPlatformAccessory } from '../src/WledWsPlatformAccessory';
import { WledDevice } from '../src/WledDevice';
import {
  clients,
  createAccessory,
  flushPromises,
  mockLogger,
  mockPlatform,
} from './helpers/fakeWled';

describe('WledWsPlatformAccessory initial state', () => {
  let accessory: ReturnType<typeof createAccessory>;
  let device: WledDevice;
  let instance: WledWsPlatformAccessory;

  // WLEDClient.setContext() emits the state before the info
  const emitInitialContext = () => {
    clients[0].emit('update:state');
    clients[0].emit('update:info');
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clients.length = 0;
    accessory = createAccessory();
    device = new WledDevice(accessory.context.device as any, mockLogger as any, false);
    instance = new WledWsPlatformAccessory(
      mockPlatform as any,
      mockLogger as any,
      accessory as any,
      device,
      false,
    );
    device.connect(false);
    clients[0].state = {
      on: true,
      liveDataOverride: 1,
      brightness: 128,
      segments: [{ colors: [[255, 0, 0]], cct: 127 }],
      presetId: -1,
      playlistId: -1,
    };
    clients[0].info = {
      brand: 'WLED',
      product: 'FOSS',
      version: '0.15.0',
      mac: 'aabbccddeeff',
      leds: { lightCapabilities: 1 },
    };
    clients[0].emit('open');
    await flushPromises();
  });

  afterEach(() => {
    device.disconnect();
    jest.useRealTimers();
  });

  it('applies the brightness of the state received before the info', async () => {
    (clients[0].state as any).brightness = 13; // 5%
    emitInitialContext();

    await expect(instance.getBrightness()).resolves.toBe(5);
    expect(accessory.mainService.updateCharacteristic).toHaveBeenCalledWith(
      'Brightness',
      5,
    );
  });

  it('applies the color of the state received before the info', async () => {
    (clients[0].state as any).segments[0].colors[0] = [0, 0, 255];
    emitInitialContext();

    await expect(instance.getHue()).resolves.toBe(240);
    await expect(instance.getSaturation()).resolves.toBe(100);
  });

  it('applies the color temperature of the state received before the info', async () => {
    (clients[0].info as any).leds.lightCapabilities = 6; // WCCT
    (clients[0].state as any).segments[0].cct = 255;
    emitInitialContext();

    await expect(instance.getColorTemperature()).resolves.toBe(140);
  });
});
