import {
  brightnessToLevel,
  cctToMired,
  levelToBrightness,
  matterHsToRgb,
  miredToCct,
  rgbToMatterHs,
  rgbToXy,
  xyToRgb,
} from '../src/WledUtils';

describe('WledUtils', () => {
  describe('brightness <-> Matter level', () => {
    it('maps the full range', () => {
      expect(brightnessToLevel(255)).toBe(254);
      expect(levelToBrightness(254)).toBe(255);
      expect(levelToBrightness(0)).toBe(0);
    });

    it('never reports level 0 for a dimmed light', () => {
      expect(brightnessToLevel(0)).toBe(1);
      expect(brightnessToLevel(1)).toBe(1);
    });

    it('round-trips every WLED brightness within 1 step', () => {
      for (let bri = 1; bri <= 255; bri++) {
        expect(Math.abs(levelToBrightness(brightnessToLevel(bri)) - bri)).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Matter hue/saturation <-> RGB', () => {
    it.each([
      [[255, 0, 0], 0, 254],
      [[0, 255, 0], 85, 254],
      [[0, 0, 255], 169, 254],
      [[255, 255, 255], 0, 0],
    ])('maps %j to hue %d saturation %d', (rgb, hue, saturation) => {
      expect(rgbToMatterHs(rgb[0], rgb[1], rgb[2])).toEqual({ hue, saturation });
    });

    it('converts primary colors back', () => {
      expect(matterHsToRgb(0, 254)).toEqual({ r: 255, g: 0, b: 0 });
      expect(matterHsToRgb(0, 0)).toEqual({ r: 255, g: 255, b: 255 });
    });
  });

  describe('RGB <-> CIE xy', () => {
    it('maps sRGB primaries to their xy coordinates', () => {
      // sRGB primaries: red (0.64, 0.33), green (0.30, 0.60), blue (0.15, 0.06)
      const near = (value: number, expected: number) =>
        expect(Math.abs(value / 65536 - expected)).toBeLessThan(0.002);
      const red = rgbToXy(255, 0, 0);
      near(red.x, 0.64);
      near(red.y, 0.33);
      const green = rgbToXy(0, 255, 0);
      near(green.x, 0.3);
      near(green.y, 0.6);
      const blue = rgbToXy(0, 0, 255);
      near(blue.x, 0.15);
      near(blue.y, 0.06);
    });

    it('uses the white point for black', () => {
      const black = rgbToXy(0, 0, 0);
      const white = rgbToXy(255, 255, 255);
      expect(Math.abs(black.x - white.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(black.y - white.y)).toBeLessThanOrEqual(2);
    });

    it.each([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
      [255, 128, 0],
      [128, 0, 255],
    ])('round-trips %d,%d,%d', (r, g, b) => {
      const { x, y } = rgbToXy(r, g, b);
      const rgb = xyToRgb(x, y);
      expect(Math.abs(rgb.r - r)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.g - g)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.b - b)).toBeLessThanOrEqual(2);
    });

    it('clips colors outside the sRGB gamut', () => {
      const rgb = xyToRgb(0, 65279);
      for (const c of [rgb.r, rgb.g, rgb.b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    });
  });

  describe('mired <-> CCT', () => {
    it('maps the range ends', () => {
      expect(miredToCct(500)).toBe(0);
      expect(miredToCct(140)).toBe(255);
      expect(cctToMired(0)).toBe(500);
      expect(cctToMired(255)).toBe(140);
    });
  });
});
