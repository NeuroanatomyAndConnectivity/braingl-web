import type { GlyphStyle } from "../render/renderer";

/** User-facing parameters of the glyph workspace (brainGL's dataset property panels). */
export interface GlyphParams {
  // view
  surface: number;
  hemi: 0 | 1 | 2;
  background: string;
  secondView: boolean;
  secondSurface: number;
  // surface
  showSurface: boolean;
  surfaceColorMode: string; // "solid" | "sulc" | "seed" | "overlay:<name>"
  surfaceColor: string;
  surfaceAlpha: number;
  // glyphs
  showGlyphs: boolean;
  glyphStyle: GlyphStyle;
  glyphRadius: number;
  primSize: number;
  roundPoints: boolean;
  normalization: number;
  glyphAlpha: number;
  glyphGeometry: number; // surface index, or -1 = polar projection of the sphere
  glyphColorMode: 0 | 1; // orientation | value
  colorSurface: number;
  rotationEnabled: boolean;
  rotX: number;
  rotY: number;
  rotZ: number;
  depthLift: number;
  // thresholds
  threshold: number;
  maxThreshold: number;
  sign: 0 | 1 | 2;
  minLength: number;
  lengthSurface: number;
  budgetM: number;
  // colour map
  colormap: string;
  cmin: number;
  cmax: number;
  seedLower: number;
  // ROI / paint
  tool: "navigate" | "seed" | "paint" | "erase";
  brushSize: number;
  paintColor: string;
  showPaint: boolean;
  glyphNodes: "all" | "painted";
  // anatomical background glyphs
  littleBrains: boolean;
  lbColorMode: 0 | 1 | 2;
  lbMax: number;
  // connections
  showConnections: boolean;
  maxConnexels: number;
  lineWidth: number;
  lineAlpha: number;
  lineColorMode: 0 | 1;
  bundleCompat: number;
  bundleBell: number;
  // export
  screenshotScale: number;
}

export const defaultGlyphParams: GlyphParams = {
  surface: 1,
  hemi: 0,
  background: "#101014",
  secondView: true,
  secondSurface: 0,
  showSurface: true,
  surfaceColorMode: "sulc",
  surfaceColor: "#c9c9cf",
  surfaceAlpha: 1,
  showGlyphs: true,
  glyphStyle: "points",
  glyphRadius: 0.03,
  primSize: 2,
  roundPoints: true,
  normalization: 0.5,
  glyphAlpha: 1,
  glyphGeometry: 0,
  glyphColorMode: 0,
  colorSurface: 0,
  rotationEnabled: false,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  depthLift: 1,
  threshold: 0.5,
  maxThreshold: 1,
  sign: 0,
  minLength: 20,
  lengthSurface: 0,
  budgetM: 4,
  colormap: "cool - warm",
  cmin: -0.8,
  cmax: 0.8,
  seedLower: 0.2,
  tool: "navigate",
  brushSize: 8,
  paintColor: "#ffb000",
  showPaint: true,
  glyphNodes: "all",
  littleBrains: false,
  lbColorMode: 1,
  lbMax: 200,
  showConnections: true,
  maxConnexels: 5000,
  lineWidth: 1.2,
  lineAlpha: 0.5,
  lineColorMode: 0,
  bundleCompat: 0.8,
  bundleBell: 5,
  screenshotScale: 2,
};
