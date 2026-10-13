import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import { WLEDClient, WLEDClientState } from 'wled-client';
import { WledController, LightCapability, WledPreset } from './WledController';
import Timeout = NodeJS.Timeout;

/**
 * Device information reported by the controller after the first connect
 */
export interface WledDeviceInfo {
  brand: string;
  product: string;
  version: string;
  mac: string;
  lightCapability: LightCapability;
}

/**
 * Events emitted by WledDevice. Protocol adapters (HomeKit, Matter) subscribe to these.
 */
export interface WledDeviceEvents {
  // websocket connection established
  connected: [];
  // websocket connection lost, a reconnect is scheduled
  disconnected: [];
  // controller state received (sent on every state update, adapters compare against their own state)
  state: [state: WLEDClientState];
  // device information received for the first time
  info: [info: WledDeviceInfo];
  // list of configured presets/playlists available on the controller
  presets: [presets: WledPreset[]];
  // on state of a preset/playlist changed because of a controller state update
  presetChanged: [preset: WledPreset];
}

/**
 * Protocol-neutral connection to one WLED controller. Owns the websocket client, the
 * reconnect/heartbeat logic, the preset list and the preset/playlist activity tracking.
 * Contains no HomeKit or Matter specific code.
 */
export class WledDevice extends EventEmitter<WledDeviceEvents> {
  private presetList: WledPreset[] = [];
  private activePresetId: string | null = null;
  private presetId = '-1';
  private playlistId = '-1';
  private wledClient;
  private connectionClosed = false;
  private connectionEstablished = false;
  private reconnectIntervalId: Timeout | null = null;
  private heartbeatIntervalId: Timeout | null = null;
  private pongTimeoutId: Timeout | null = null;
  private reconnectIntervalMillis = 10000;
  private heartbeatIntervalMillis = 30000;
  private pongTimeoutMillis = 10000;
  private heartbeatSupported = true;
  private init = false;

  constructor(
    public readonly controller: WledController,
    private readonly log: Logger,
    private readonly loggingEnabled: boolean,
  ) {
    super();
  }

  /**
   * True while the websocket connection to the controller is established
   */
  get connected(): boolean {
    return this.connectionEstablished;
  }

  /**
   * Configured presets/playlists which are available on the controller
   */
  get presets(): WledPreset[] {
    return this.presetList;
  }

  turnOn() {
    this.wledClient.turnOn();
  }

  turnOff() {
    this.wledClient.turnOff();
  }

  /**
   * @param brightness 0..255
   */
  setBrightness(brightness: number) {
    this.wledClient.setBrightness(brightness);
  }

  /**
   * @param color [r, g, b] or [r, g, b, w], 0..255 each
   */
  setColor(color: number[]) {
    this.wledClient.setColor(color);
  }

  /**
   * @param cct 0 (warm) .. 255 (cold)
   */
  setCCT(cct: number) {
    this.wledClient.setCCT(cct);
  }

  /**
   * Enable or disable the realtime (live data) mode
   */
  setLive(live: boolean) {
    if (live) {
      this.wledClient.allowLiveData();
    } else {
      if (this.loggingEnabled){
        this.log.info(
          'Resetting real time mode after stream for controller %s: %s',
          this.controller.name,
          this.controller.resetRealTimeModeAfterStream ? 'true' : 'false',
        );
      }
      this.wledClient.ignoreLiveData(!this.controller.resetRealTimeModeAfterStream);
    }
  }

  /**
   * Activates a preset/playlist or turns the controller off
   */
  setPreset(preset: WledPreset, on: boolean) {
    if (this.loggingEnabled){
      this.log.info(
        'Set On state for %s %s (%s) of controller %s to: %s',
        preset.isPlaylist ? 'playlist' : 'preset',
        preset.id,
        preset.name,
        this.controller.name,
        on ? 'On' : 'Off',
      );
    }

    // switch on new preset
    preset.on = on;
    if (preset.on) {
      this.wledClient.setPreset(preset.id);
    } else {
      this.wledClient.turnOff();
    }
  }

  /**
   * Connect the controller and bind the callback handlers for
   * state, info, effects, palettes, presets, deviceOptions, lightCapabilities, config
   */
  async connect(isReconnect: boolean): Promise<boolean> {
    this.connectionClosed = false;
    this.connectionEstablished = false;

    const controller = this.controller;
    this.log.info(
      `${isReconnect ? 'Reconnecting' : 'Connecting'} to controller %s at address %s`,
      controller.name,
      controller.address,
    );

    // drop a previous client (if any) so its socket can't linger or report stale events
    this.terminateWebsocket();

    const client = new WLEDClient({
      host: controller.address,
      websocket: {
        reconnect: false, // we have our own reconnect logic, turn off WLEDClient reconnect
      },
      immediate: true,
      secure: false,
      init: {
        presets: true,
        config: true,
      },
    });
    this.wledClient = client;

    // events of a client that has been replaced by a reconnect must not touch the current state
    const isCurrent = () => client === this.wledClient;

    client.on('open', () => {
      if (isCurrent()) {
        this.onConnected();
      }
    });

    client.on('close', () => {
      if (isCurrent()) {
        this.clearHeartbeat();
        this.onDisconnected();
      }
    });

    // update accessory state
    client.on('update:state', () => {
      if (isCurrent()) {
        this.resetHeartbeatInterval();
        this.onStateReceived();
      }
    });

    client.on('update:presets', () => {
      if (isCurrent()) {
        this.resetHeartbeatInterval();
        this.onPresetsReceived();
      }
    });

    client.on('update:effects', () => {
      if (isCurrent()) {
        this.resetHeartbeatInterval();
        this.onEffectsReceived();
      }
    });

    client.on('update:config', () => {
      if (isCurrent()) {
        this.resetHeartbeatInterval();
        this.onConfigReceived();
      }
    });

    client.on('update:info', () => {
      if (isCurrent()) {
        this.resetHeartbeatInterval();
        this.onInfoReceived();
      }
    });

    client.on('error', (error) => {
      if (isCurrent()) {
        this.clearHeartbeat();
        this.onError(error);
      }
    });

    try {
      await client.init();
    } catch {
      this.log.error(
        'Error connecting controller %s at address %s',
        controller.name,
        controller.address,
      );
    }

    // WLEDClient only reports an error if both HTTP and websocket failed. If just the websocket
    // could not be opened, no event is emitted at all - make sure a reconnect is scheduled anyway
    if (isCurrent() && !this.connectionEstablished && !this.connectionClosed) {
      this.log.error(
        'Websocket connection to controller %s at address %s could not be established',
        controller.name,
        controller.address,
      );
      this.scheduleReconnect();
    }
    return true;
  }

  /**
   * Disconnects the controller. This happens on shutdown of the plugin only
   */
  disconnect() {
    if (!this.connectionClosed) {
      this.log.info('Disconnecting controller %s', this.controller.name);

      if (this.reconnectIntervalId !== null) {
        clearTimeout(this.reconnectIntervalId);
        this.reconnectIntervalId = null;
      }

      this.clearHeartbeat();
      this.connectionClosed = true;
      this.wledClient?.disconnect();
    }
  }

  /**
   * Close the current websocket immediately. A regular close() waits for the closing
   * handshake, which never completes on a dead connection.
   */
  terminateWebsocket() {
    if (!this.wledClient) {
      return;
    }

    try {
      const websocket = this.wledClient.WSAPI?.websocket;
      if (websocket && typeof websocket.terminate === 'function') {
        websocket.terminate();
      } else {
        this.wledClient.disconnect();
      }
    } catch (error) {
      this.log.error(
        'Error disconnecting stale websocket for controller %s: %s',
        this.controller.name,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Callback: each time controller's state changes this function is called. State changes can
   * triggered by user interaction or other clients. Adapters are notified first, afterwards the
   * preset/playlist states are updated.
   */
  onStateReceived() {
    const controller = this.controller;
    const state = this.wledClient.state;
    this.log.debug(
      `Received controller %s state update ${JSON.stringify(state)}`,
      controller.name,
    );

    this.emit('state', state);

    // check for updated preset
    if (this.presetId !== state.presetId) {

      if (this.loggingEnabled){
        this.log.info(
          'Controller %s updated current preset to: %s',
          controller.name,
          state.presetId,
        );
      }

      // switch off active preset first
      const activePreset = this.findPreset(this.activePresetId);
      if (activePreset !== undefined) {
        activePreset.on = false;

        if (this.loggingEnabled){
          this.log.info(
            'Set On state for last active %s %s (%s) of controller %s to: %s',
            activePreset.isPlaylist ? 'playlist' : 'preset',
            activePreset.id,
            activePreset.name,
            controller.name,
            activePreset.on ? 'On' : 'Off',
          );
        }

        this.emit('presetChanged', activePreset);
        this.activePresetId = null;
      } else {
        this.log.debug(
          'Last active preset not set for controller %s',
          controller.name,
        );
      }

      // switch to new preset and update state
      const newPreset = this.findPreset(state.presetId.toString());
      if (newPreset !== undefined) {
        newPreset.on = state.on;

        if (this.loggingEnabled){
          this.log.info(
            'Set On state for new %s %s (%s) of controller %s to: %s',
            newPreset.isPlaylist ? 'playlist' : 'preset',
            newPreset.id,
            newPreset.name,
            controller.name,
            newPreset.on ? 'On' : 'Off',
          );
        }

        this.emit('presetChanged', newPreset);

        // set new preset as active preset
        this.activePresetId = newPreset.id;
      } else {
        if (state.presetId.toString() === '-1') {
          this.log.debug(
            'No preset selected by controller %s',
            controller.name,
          );
        } else {
          this.log.debug(
            'Preset not configured for controller %s',
            controller.name,
          );
        }
      }
    }
    this.presetId = state.presetId;

    // check for updated playlist
    if (this.playlistId !== state.playlistId) {
      if (state.playlistId !== '-1') {

        if (this.loggingEnabled){
          this.log.info(
            'Controller %s updated current playlist to: %s',
            controller.name,
            state.playlistId,
          );
        }

        // immediately switch off playlist
        const newPlaylist = this.findPreset(state.playlistId.toString());
        if (newPlaylist !== undefined) {
          newPlaylist.on = false;

          if (this.loggingEnabled){
            this.log.info(
              'Set On state for new %s %s (%s) of controller %s to: %s',
              newPlaylist.isPlaylist ? 'playlist' : 'preset',
              newPlaylist.id,
              newPlaylist.name,
              controller.name,
              newPlaylist.on ? 'On' : 'Off',
            );
          }

          this.emit('presetChanged', newPlaylist);
        }
      }
      this.playlistId = state.playlistId;
    }
  }

  /**
   * Callback: each time controller's presets changes this function is called. Preset changes can
   * triggered by user interaction or other clients. This function checks, if the configured presets
   * are available on the controller. If not, a error message is logged to the console
   */
  onPresetsReceived() {
    const controller = this.controller;

    if (this.loggingEnabled){
      this.log.debug(
        `Received presets for controller %s ${JSON.stringify(this.wledClient.presets)}`,
        controller.name,
      );
    }

    // check if presets are configured by user and create list of available presets on the controller
    if (controller.presets !== undefined) {
      const configuredPresets: string[] = controller.presets.split(',');
      const availablePresets: WledPreset[] = [];
      for (const key of Object.keys(this.wledClient.presets)) {
        if (
          Object.prototype.hasOwnProperty.call(this.wledClient.presets, key)
        ) {
          if (
            Object.prototype.hasOwnProperty.call(
              this.wledClient.presets[key],
              'name',
            )
          ) {
            const isPlaylist = !Object.prototype.hasOwnProperty.call(
              this.wledClient.presets[key],
              'segments',
            );
            availablePresets.push({
              id: key,
              name: this.wledClient.presets[key].name,
              isPlaylist: isPlaylist,
              // keep the state of presets we already know
              on: this.findPreset(key)?.on ?? false,
            });
            this.log.debug(
              'Got %s %s from controller %s',
              isPlaylist ? 'playlist' : 'preset',
              this.wledClient.presets[key].name,
              controller.name,
            );
          }
        }
      }

      const missingPresets = configuredPresets.filter(
        (str) => !availablePresets.some((obj) => obj.name === str),
      );

      if (missingPresets.length > 0) {
        this.log.error(
          'Configured preset(s) %s not supported by controller %s',
          missingPresets,
          controller.name,
        );
      }

      // reduce list with presets to the user configured elements
      this.presetList = availablePresets.filter((obj) =>
        configuredPresets.includes(obj.name),
      );
      this.emit('presets', this.presetList);
    }
  }

  /**
   * Callback: each time controller's effects changes this function is called. Effect changes can
   * triggered by user interaction or other clients
   */
  onEffectsReceived() {
    this.log.debug(
      `Received effects for controller %s ${JSON.stringify(this.wledClient.effects)}`,
      this.controller.name,
    );
  }

  /**
   * Callback: each time controller's config changes this function is called. Config changes can
   * triggered by user interaction or other clients
   */
  onConfigReceived() {
    this.log.debug(
      `Received config for controller %s ${JSON.stringify(this.wledClient.config)}`,
      this.controller.name,
    );
  }

  /**
   * Callback: each time controller's info changes this function is called. State info can
   * triggered by user interaction or other clients
   */
  onInfoReceived() {
    if (this.loggingEnabled){
      this.log.info(
        `Received ${!this.init ? 'initial ' : ''}info for controller %s`,
        this.controller.name,
      );
    }

    // initialize accessory information only once at startup
    if (!this.init) {
      this.emit('info', this.readDeviceInfo());
      this.init = true;
    }
  }

  /**
   * Refresh presets to update preset information. This is done, when the controller is turned off
   * to avoid too much cpu load on the controller when the lights or effetcs are on. Presets can be
   * configured by the user or an API anytime - so we need to update this information regularly.
   */
  refreshPresets() {
    if (this.loggingEnabled){
      this.log.info('Requesting presets for controller %s', this.controller.name);
    }

    this.wledClient.refreshPresets();
  }

  /**
   * Refresh effects to update effect information.
   */
  refreshEffects() {
    if (this.loggingEnabled){
      this.log.info('Requesting effects for controller %s', this.controller.name);
    }

    this.wledClient.refreshEffects();
  }

  /**
   * Callback: connection to the controller is established
   */
  onConnected() {
    this.log.info('Controller %s connected', this.controller.name);
    this.connectionEstablished = true;

    // the websocket is replaced on every reconnect, so the pong listener is registered per connection
    const websocket = this.wledClient.WSAPI?.websocket;
    if (websocket && typeof websocket.on === 'function') {
      websocket.on('pong', () => {
        if (websocket === this.wledClient.WSAPI?.websocket) {
          this.resetHeartbeatInterval();
        }
      });
    }

    this.resetHeartbeatInterval();
    this.emit('connected');
  }

  /**
   * Reset the active websocket heartbeat interval. Any websocket data from WLED
   * counts as activity, so the next ping is only sent after the connection has
   * been quiet for heartbeatIntervalMillis.
   */
  resetHeartbeatInterval() {
    this.clearHeartbeat();

    if (
      !this.heartbeatSupported ||
      this.connectionClosed ||
      !this.connectionEstablished
    ) {
      return;
    }

    this.heartbeatIntervalId = setTimeout(() => {
      this.sendHeartbeatPing();
    }, this.heartbeatIntervalMillis);
  }

  /**
   * Send a websocket ping and reconnect if the underlying websocket rejects it or
   * no answer (pong or any other data) is received within pongTimeoutMillis.
   * A ping on a dead connection usually does not fail, so the missing answer is
   * the only reliable indication for a lost connection.
   */
  sendHeartbeatPing() {
    if (
      !this.heartbeatSupported ||
      this.connectionClosed ||
      !this.connectionEstablished
    ) {
      return;
    }

    const controller = this.controller;
    const websocket = this.wledClient.WSAPI?.websocket;
    const ping = websocket?.ping;

    if (typeof ping !== 'function') {
      this.heartbeatSupported = false;
      this.clearHeartbeat();

      this.log.debug(
        'Controller %s websocket heartbeat disabled; ping() is unavailable.',
        controller.name,
      );

      return;
    }

    try {
      ping.call(websocket);
    } catch (error) {
      this.onHeartbeatFailed(
        `ping failed: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    // cleared by resetHeartbeatInterval() as soon as a pong or any other data arrives
    this.pongTimeoutId = setTimeout(() => {
      this.pongTimeoutId = null;
      this.onHeartbeatFailed(
        `no answer within ${this.pongTimeoutMillis / 1000} seconds`,
      );
    }, this.pongTimeoutMillis);
  }

  /**
   * The heartbeat detected a dead connection: drop the websocket and reconnect
   */
  onHeartbeatFailed(reason: string) {
    this.log.info(
      'Controller %s websocket heartbeat %s; reconnecting',
      this.controller.name,
      reason,
    );

    this.connectionEstablished = false;
    this.clearHeartbeat();

    // the socket is replaced in connect(); events of the old client are ignored from then on
    this.terminateWebsocket();
    this.onDisconnected();
  }

  /**
   * Clear the active websocket heartbeat interval and a pending pong timeout.
   */
  clearHeartbeat() {
    if (this.heartbeatIntervalId !== null) {
      clearTimeout(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }

    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  /**
   * Callback: connection to the controller is closed
   */
  onDisconnected() {
    this.connectionEstablished = false;
    this.log.info('Controller %s disconnected', this.controller.name);

    this.clearHeartbeat();
    this.scheduleReconnect();
    this.emit('disconnected');
  }

  /**
   * Callback: connection to the controller throws an error (e.g. is closed by controller)
   */
  onError(error) {
    this.log.error(
      'Controller %s communication error: ' + error.message,
      this.controller.name,
    );
    this.connectionEstablished = false;

    this.clearHeartbeat();
    this.scheduleReconnect();
    this.emit('disconnected');
  }

  /**
   * (Re)starts the reconnect timer unless the connection was closed on purpose
   */
  scheduleReconnect() {
    if (this.reconnectIntervalId !== null) {
      clearTimeout(this.reconnectIntervalId);
      this.reconnectIntervalId = null;
    }

    if (!this.connectionClosed) {
      this.reconnectIntervalId = setTimeout(() => {
        this.reconnectIntervalId = null;
        if (!this.connectionEstablished) {
          this.connect(true);
        }
      }, this.reconnectIntervalMillis);
    }
  }

  /**
   * Read the device information. WLED supports different LED stripe types, which are reported
   * via the JSON object "info" and its element "lightCapabilities".
   *
   * See https://kno.wled.ge/interfaces/json-api/#light-capabilities
   */
  private readDeviceInfo(): WledDeviceInfo {
    const controller = this.controller;
    const info = this.wledClient.info;
    this.log.info(
      'Update accessory info for controller %s to: brand=%s product=%s version=%s mac=%s lc=%s',
      controller.name,
      info.brand,
      info.product,
      info.version,
      info.mac,
      info.leds.lightCapabilities,
    );

    if (!info.leds.hasOwnProperty('lightCapabilities')) {
      info.leds.segmentLightCapabilities = [1];
      info.leds.lightCapabilities = 1;
      this.log.error('Please update controller %s firmware to latest one!', controller.name);
    }
    const lc: LightCapability = <LightCapability>(
      JSON.parse(info.leds.lightCapabilities)
    );

    if (lc === LightCapability.OnOff) {
      this.log.info('Controller %s supports OnOff channel', controller.name);
    }

    if (lc === LightCapability.RGB) {
      this.log.info('Controller %s supports RGB channel', controller.name);
    }

    if (lc === LightCapability.White) {
      this.log.info('Controller %s supports White channel', controller.name);
    }

    if (lc === LightCapability.RGBW) {
      this.log.info('Controller %s supports RGBW channel', controller.name);
    }

    if (lc === LightCapability.WCCT) {
      this.log.info('Controller %s supports White channel with CCT', controller.name);
    }
    if (lc === LightCapability.RGBWCCT) {
      this.log.info('Controller %s supports RGBW channel with CCT', controller.name);
    }

    return {
      brand: info.brand,
      product: info.product,
      version: info.version,
      mac: info.mac,
      lightCapability: lc,
    };
  }

  private findPreset(id: string | null): WledPreset | undefined {
    return id === null ? undefined : this.presetList.find((obj) => obj.id === id);
  }
}
