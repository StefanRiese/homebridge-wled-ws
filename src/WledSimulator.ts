import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Logger } from 'homebridge';
import { WebSocket, WebSocketServer } from 'ws';

type Color = [number, number, number];

interface SimulatorPreset {
  n: string;
  on: boolean;
  bri: number;
  col: Color;
}

// the presets of the test controller, see README "Test controller"
export const SIMULATOR_PRESETS: Record<string, SimulatorPreset> = {
  '1': { n: 'Test Red', on: true, bri: 128, col: [255, 0, 0] },
  '2': { n: 'Test Blue', on: true, bri: 255, col: [0, 0, 255] },
};

export const SIMULATOR_NAME = 'WLED Test';
export const SIMULATOR_DEFAULT_PORT = 18099;

/**
 * A minimal WLED controller (JSON API via HTTP and WebSocket) for testing the plugin without
 * hardware: one RGB segment, on/off, brightness, color, real-time mode and two presets.
 * It listens on the loopback interface only.
 */
export class WledSimulator {
  private server?: Server;
  private websockets?: WebSocketServer;

  private on = false;
  private brightness = 128;
  private color: Color = [255, 160, 0];
  private presetId = -1;
  private liveDataOverride = 0;

  constructor(
    private readonly log: Logger,
    private readonly port: number,
    private readonly loggingEnabled: boolean,
  ) {}

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /**
   * Start listening, rejects if the port is not available
   */
  start(): Promise<void> {
    const server = createServer((request, response) => this.onHttpRequest(request, response));
    const websockets = new WebSocketServer({ server, path: '/ws' });
    websockets.on('connection', (websocket) => this.onWebsocketConnection(websocket));
    // the WebSocket server forwards errors of the HTTP server, these are handled below
    websockets.on('error', () => undefined);
    this.server = server;
    this.websockets = websockets;

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.log.info(
          'Test controller %s listening on %s',
          SIMULATOR_NAME,
          `127.0.0.1:${(server.address() as AddressInfo).port}`,
        );
        resolve();
      });
    });
  }

  stop() {
    for (const websocket of this.websockets?.clients ?? []) {
      websocket.terminate();
    }
    this.websockets?.close();
    this.server?.close();
  }

  private onHttpRequest(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'POST' && (path === '/json' || path === '/json/state')) {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        try {
          const update = JSON.parse(body);
          this.apply(update, 'HTTP');
          this.sendJson(response, update.v ? this.context() : { success: true });
        } catch {
          this.sendJson(response, { error: 9 }, 400);
        }
      });
      return;
    }

    const content: Record<string, () => unknown> = {
      '/json': () => ({ ...this.context(), effects: ['Solid'], palettes: ['Default'] }),
      '/json/state': () => this.state(),
      '/json/info': () => this.info(),
      '/json/si': () => this.context(),
      '/json/eff': () => ['Solid'],
      '/json/pal': () => ['Default'],
      '/json/cfg': () => ({}),
      '/presets.json': () => this.presets(),
    };
    const get = content[path];
    if (request.method === 'GET' && get) {
      this.sendJson(response, get());
    } else {
      this.sendJson(response, { error: 'Not found' }, 404);
    }
  }

  private sendJson(response: ServerResponse, body: unknown, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private onWebsocketConnection(websocket: WebSocket) {
    // like WLED: the full state is sent on connect
    websocket.send(JSON.stringify(this.context()));
    websocket.on('message', (data) => {
      try {
        this.apply(JSON.parse(data.toString()), 'WebSocket');
      } catch {
        // WLED ignores invalid messages
      }
    });
  }

  /**
   * Apply a (partial) WLED state and send the new state to all WebSocket clients, like WLED
   */
  private apply(update: Record<string, unknown>, transport: string) {
    const changes = { ...update };
    delete changes.v;
    if (Object.keys(changes).length === 0) {
      return;
    }
    if (this.loggingEnabled) {
      this.log.info('Test controller %s received via %s: %s', SIMULATOR_NAME, transport, JSON.stringify(changes));
    }

    let stateChanged = false;
    const preset = changes.ps !== undefined ? SIMULATOR_PRESETS[String(changes.ps)] : undefined;
    if (preset) {
      this.on = preset.on;
      this.brightness = preset.bri;
      this.color = [...preset.col];
      this.presetId = Number(changes.ps);
    }

    if (changes.on !== undefined) {
      this.on = changes.on === 't' ? !this.on : changes.on === true;
      stateChanged = true;
    }
    if (typeof changes.bri === 'number') {
      this.brightness = changes.bri;
      stateChanged = true;
    }
    if (typeof changes.lor === 'number') {
      this.liveDataOverride = changes.lor;
    }
    const segments = Array.isArray(changes.seg) ? changes.seg : changes.seg ? [changes.seg] : [];
    for (const segment of segments as Record<string, unknown>[]) {
      if ((segment.id ?? 0) !== 0) {
        continue;
      }
      const colors = segment.col as number[][] | undefined;
      if (Array.isArray(colors?.[0])) {
        this.color = [colors[0][0], colors[0][1], colors[0][2]];
        stateChanged = true;
      }
      if (segment.on !== undefined) {
        this.on = segment.on === true;
        stateChanged = true;
      }
      if (typeof segment.bri === 'number') {
        this.brightness = segment.bri;
        stateChanged = true;
      }
    }

    // like WLED: a manual change deselects the active preset
    if (stateChanged && !preset) {
      this.presetId = -1;
    }
    this.broadcast();
  }

  private broadcast() {
    const message = JSON.stringify(this.context());
    for (const websocket of this.websockets?.clients ?? []) {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(message);
      }
    }
  }

  private context() {
    return { state: this.state(), info: this.info() };
  }

  private state() {
    return {
      on: this.on,
      bri: this.brightness,
      transition: 7,
      ps: this.presetId,
      pl: -1,
      lor: this.liveDataOverride,
      mainseg: 0,
      seg: [
        {
          id: 0,
          start: 0,
          stop: 30,
          len: 30,
          on: true,
          bri: 255,
          col: [this.color, [0, 0, 0], [0, 0, 0]],
          fx: 0,
          sx: 128,
          ix: 128,
          pal: 0,
          sel: true,
        },
      ],
    };
  }

  private info() {
    return {
      ver: '0.15.0-test',
      vid: 2410140,
      leds: { count: 30, rgbw: false, wv: 0, cct: 0, lc: 1, seglc: [1], maxseg: 32 },
      name: SIMULATOR_NAME,
      udpport: 21324,
      live: false,
      lm: '',
      lip: '',
      ws: this.websockets?.clients.size ?? 0,
      fxcount: 1,
      palcount: 1,
      arch: 'simulator',
      core: '',
      brand: 'WLED',
      product: 'Simulator',
      mac: '000000000000',
      ip: '127.0.0.1',
    };
  }

  private presets() {
    const presets: Record<string, unknown> = { '0': {} };
    for (const [id, preset] of Object.entries(SIMULATOR_PRESETS)) {
      presets[id] = {
        n: preset.n,
        on: preset.on,
        bri: preset.bri,
        seg: [{ id: 0, col: [preset.col, [0, 0, 0], [0, 0, 0]] }],
      };
    }
    return presets;
  }
}
