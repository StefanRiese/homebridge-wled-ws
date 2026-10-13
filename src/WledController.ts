// see config.schema.json
export interface WledController {
  name: string;
  address: string;
  presets: string;
  showRealTimeModeButton: boolean;
  resetRealTimeModeAfterStream: boolean;
}

export enum LightCapability {
  OnOff = 0,
  RGB = 1,
  White = 2,
  RGBW = 3,
  WCCT = 6,
  RGBWCCT = 7
}

// a preset or playlist configured by the user and available on the controller
export interface WledPreset {
  id: string;
  name: string;
  on: boolean;
  isPlaylist: boolean;
}
