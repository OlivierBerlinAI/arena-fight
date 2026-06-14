/** Shared palette for the 3D scene and the minimap. */
import type { Ownership } from '@mech-arena-fight/shared';

export const TEAM_HEX: [number, number] = [0x22d3ee, 0xf97316]; // cyan / orange
export const TEAM_CSS: [string, string] = ['#22d3ee', '#f97316'];
export const NEUTRAL_HEX = 0x8a94a3;
export const NEUTRAL_CSS = '#8a94a3';

export const GROUND_HEX = 0x0a0e14;
export const GRID_HEX = 0x1d2733;
export const GRID_CENTER_HEX = 0x2a3a4f;

export function teamHex(owner: Ownership): number {
  return owner === 0 ? TEAM_HEX[0] : owner === 1 ? TEAM_HEX[1] : NEUTRAL_HEX;
}

export function teamCss(owner: Ownership): string {
  return owner === 0 ? TEAM_CSS[0] : owner === 1 ? TEAM_CSS[1] : NEUTRAL_CSS;
}
