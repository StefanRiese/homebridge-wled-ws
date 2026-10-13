/**
 * Translates HSV to RGB
 * @param r RED color 0..255
 * @param g GREEN color 0..255
 * @param b BLUE color 0..255
 * @returns [H, S, V]
 */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  // Normalize RGB values to be in the range [0, 1]
  const normalizedR = r / 255;
  const normalizedG = g / 255;
  const normalizedB = b / 255;

  // Find the maximum and minimum values among RGB components
  const max = Math.max(normalizedR, normalizedG, normalizedB);
  const min = Math.min(normalizedR, normalizedG, normalizedB);

  // Calculate the value (V)
  const v = max;

  // Calculate the saturation (S)
  const s = max === 0 ? 0 : (max - min) / max;

  // Calculate the hue (H)
  let h = 0;

  if (max === min) {
    // Achromatic (gray) case, H is undefined but typically set to 0
    h = 0;
  } else {
    const delta = max - min;
    if (max === normalizedR) {
      h =
        (normalizedG - normalizedB) / delta +
        (normalizedG < normalizedB ? 6 : 0);
    } else if (max === normalizedG) {
      h = (normalizedB - normalizedR) / delta + 2;
    } else {
      h = (normalizedR - normalizedG) / delta + 4;
    }

    // Normalize H to be in the range [0, 1]
    h /= 6;
  }

  return { h, s, v };
}

/**
 * Translates HSV to RGB
 * @param h (H)ue
 * @param s (S)aturation
 * @param v (V)alue
 * @returns [R,G,B] Color 0..255
 */
export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  // Ensure H, S, and V are within valid ranges
  const hue = h >= 0 && h <= 1 ? h : h % 1;
  const saturation = Math.max(0, Math.min(1, s));
  const value = Math.max(0, Math.min(1, v));

  // Calculate RGB components
  let r, g, b;

  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = value * (1 - saturation);
  const q = value * (1 - f * saturation);
  const t = value * (1 - (1 - f) * saturation);

  switch (i % 6) {
    case 0:
      r = value;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = value;
      b = p;
      break;
    case 2:
      r = p;
      g = value;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = value;
      break;
    case 4:
      r = t;
      g = p;
      b = value;
      break;
    case 5:
      r = value;
      g = p;
      b = q;
      break;
    default:
      break;
  }

  // Convert RGB values to the range [0, 255]
  const normalizedR = Math.round(r * 255);
  const normalizedG = Math.round(g * 255);
  const normalizedB = Math.round(b * 255);

  return { r: normalizedR, g: normalizedG, b: normalizedB };
}

/**
 * Translates mired to CCT
 * @param mired
 * @returns cct 0..255
 */
export function miredToCct(mired: number): number {
  let cct = Math.round(255 * (500 - mired) / (500 - 140));
  if (cct < 0) cct = 0;
  if (cct > 255) cct = 255;
  return cct;
}

/**
 * Translates CCT to mired value
 * @param cct
 * @returns mired 140..500
 */
export function cctToMired(cct: number): number {
  let mired = Math.round(500 - (cct / 255) * (500 - 140));
  if (mired < 140) mired = 140;
  if (mired > 500) mired = 500;
  return mired;
}

/**
 * Translates WLED brightness to a Matter level
 * @param brightness 0..255
 * @returns level 1..254
 */
export function brightnessToLevel(brightness: number): number {
  return Math.min(254, Math.max(1, Math.round((brightness * 254) / 255)));
}

/**
 * Translates a Matter level to WLED brightness
 * @param level 0..254
 * @returns brightness 0..255
 */
export function levelToBrightness(level: number): number {
  return Math.min(255, Math.max(0, Math.round((level * 255) / 254)));
}

/**
 * Translates a Matter hue/saturation to RGB with full value
 * @param hue 0..254
 * @param saturation 0..254
 * @returns [R,G,B] Color 0..255
 */
export function matterHsToRgb(
  hue: number,
  saturation: number,
): { r: number; g: number; b: number } {
  return hsvToRgb(hue / 254, saturation / 254, 1.0);
}

/**
 * Translates RGB to a Matter hue/saturation
 * @returns hue 0..254, saturation 0..254
 */
export function rgbToMatterHs(
  r: number,
  g: number,
  b: number,
): { hue: number; saturation: number } {
  const { h, s } = rgbToHsv(r, g, b);
  return { hue: Math.round(h * 254), saturation: Math.round(s * 254) };
}

// Matter encodes CIE xy as x * 65536, limited to 65279
const XY_SCALE = 65536;
const XY_MAX = 65279;

/**
 * Translates RGB (sRGB) to Matter CIE xy coordinates
 * @returns x, y 0..65279
 */
export function rgbToXy(r: number, g: number, b: number): { x: number; y: number } {
  const linear = (c: number) => {
    const v = c / 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);

  const X = lr * 0.4124 + lg * 0.3576 + lb * 0.1805;
  const Y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const Z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505;
  const sum = X + Y + Z;

  // black has no chromaticity, use the D65 white point
  const x = sum === 0 ? 0.3127 : X / sum;
  const y = sum === 0 ? 0.329 : Y / sum;
  const scale = (v: number) => Math.min(XY_MAX, Math.max(0, Math.round(v * XY_SCALE)));
  return { x: scale(x), y: scale(y) };
}

/**
 * Translates Matter CIE xy coordinates to RGB (sRGB) with full brightness
 * @param x 0..65279
 * @param y 0..65279
 * @returns [R,G,B] Color 0..255
 */
export function xyToRgb(x: number, y: number): { r: number; g: number; b: number } {
  const cx = x / XY_SCALE;
  const cy = Math.max(y / XY_SCALE, 0.0001);

  const X = cx / cy;
  const Y = 1.0;
  const Z = (1 - cx - cy) / cy;

  // colors outside the sRGB gamut are clipped
  let lr = Math.max(0, X * 3.2406 - Y * 1.5372 - Z * 0.4986);
  let lg = Math.max(0, -X * 0.9689 + Y * 1.8758 + Z * 0.0415);
  let lb = Math.max(0, X * 0.0557 - Y * 0.204 + Z * 1.057);

  // normalize to full brightness, brightness is controlled separately
  const max = Math.max(lr, lg, lb, 0.0001);
  lr /= max;
  lg /= max;
  lb /= max;

  const gamma = (c: number) =>
    Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return { r: gamma(lr), g: gamma(lg), b: gamma(lb) };
}
