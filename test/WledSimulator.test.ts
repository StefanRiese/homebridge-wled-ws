import type { WLEDClient as WLEDClientType } from 'wled-client';
import { SIMULATOR_NAME, WledSimulator } from '../src/WledSimulator';
import { mockLogger } from './helpers/fakeWled';

// the tests use the real client (wled-client is mocked by default, see __mocks__)
const { WLEDClient } = jest.requireActual('wled-client') as typeof import('wled-client');
type WLEDClient = WLEDClientType;

const PORT = 18199;

const waitFor = async (condition: () => boolean, timeoutMillis = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMillis) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('WledSimulator', () => {
  let simulator: WledSimulator;
  let clients: WLEDClient[];

  const connect = async () => {
    const client = new WLEDClient({
      host: simulator.address,
      websocket: { reconnect: false },
      immediate: false,
      init: { presets: true, config: true },
    });
    clients.push(client);
    await client.init();
    await waitFor(() => (client as any).WSAPI.available);
    return client;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    clients = [];
    simulator = new WledSimulator(mockLogger as any, PORT, true);
    await simulator.start();
  });

  afterEach(() => {
    for (const client of clients) {
      client.disconnect();
    }
    simulator.stop();
  });

  it('reports an RGB controller with two presets', async () => {
    const client = await connect();
    expect(client.info.name).toBe(SIMULATOR_NAME);
    expect(client.info.leds.lightCapabilities).toBe(1);
    expect(client.presets['1'].name).toBe('Test Red');
    expect(client.presets['2'].name).toBe('Test Blue');
    expect(client.state.on).toBe(false);
  });

  it('applies on/off, brightness and color and sends the state to all clients', async () => {
    const client = await connect();
    const other = await connect();

    await client.turnOn();
    await client.setBrightness(42);
    await client.setColor([0, 255, 0]);

    await waitFor(() => other.state.brightness === 42 && other.state.segments[0].colors?.[0]?.[1] === 255);
    expect(other.state.on).toBe(true);
    expect(other.state.segments[0].colors?.[0]).toEqual([0, 255, 0]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Test controller %s received via %s: %s',
      SIMULATOR_NAME,
      'WebSocket',
      '{"on":true}',
    );
  });

  it('activates a preset and deselects it on a manual change', async () => {
    const client = await connect();

    await client.setPreset(2);
    await waitFor(() => client.state.presetId === 2);
    expect(client.state.on).toBe(true);
    expect(client.state.brightness).toBe(255);
    expect(client.state.segments[0].colors?.[0]).toEqual([0, 0, 255]);

    await client.setBrightness(10);
    await waitFor(() => client.state.presetId === -1);
  });

  it('accepts state updates via HTTP', async () => {
    const client = await connect();
    client.disconnect();
    await waitFor(() => !(client as any).WSAPI.available);

    await client.setPreset(1);
    expect(client.state.presetId).toBe(1);
    expect(client.state.segments[0].colors?.[0]).toEqual([255, 0, 0]);
  });

  it('rejects the start if the port is in use', async () => {
    const second = new WledSimulator(mockLogger as any, PORT, false);
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
  });
});
