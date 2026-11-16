// 用 canvas 现画贴图图集：16px tile，每个 tile 占 24px 格子，四周 4px padding
// 用边缘像素复制填充，采样时 UV 再内缩半像素，双保险防串色。
import { mulberry32 } from './rng';
import { SEED } from './config';

export const TILE = 16;
export const PAD = 4;
export const CELL = TILE + PAD * 2; // 24
export const TILE_COUNT = 8;
export const ATLAS_W = CELL * TILE_COUNT; // 192
export const ATLAS_H = CELL;              // 24

// tile 索引
export const T = {
  STONE: 0,
  DIRT: 1,
  GRASS_TOP: 2,
  GRASS_SIDE: 3,
  BORDER: 4,
  TORCH: 5,
  ORE: 6,
} as const;

type Painter = (px: Uint8ClampedArray, rand: () => number) => void;

function makeTile(paint: Painter, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(TILE, TILE);
  paint(img.data, mulberry32(seed));
  ctx.putImageData(img, 0, 0);
  return c;
}

function speckle(
  base: [number, number, number],
  amp: number,
  rand: () => number,
  extra?: (x: number, y: number, rand: () => number) => [number, number, number] | null,
): Painter {
  return (px, r) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 4;
        const over = extra ? extra(x, y, r) : null;
        const c = over ?? base;
        const n = (r() - 0.5) * 2 * amp;
        px[i] = c[0] + n;
        px[i + 1] = c[1] + n;
        px[i + 2] = c[2] + n;
        px[i + 3] = 255;
      }
    }
  };
}

const painters: Painter[] = [
  speckle([122, 122, 126], 14, mulberry32(1)),                                    // stone
  speckle([134, 96, 60], 16, mulberry32(2)),                                      // dirt
  speckle([96, 166, 62], 18, mulberry32(3)),                                      // grass top
  speckle([134, 96, 60], 16, mulberry32(4), (x, y, r) =>                          // grass side
    y < 4 || (y < 6 && r() < 0.5) ? [96 + 20, 166, 62] : null),
  speckle([46, 46, 54], 8, mulberry32(5)),                                        // border
  (px, r) => {                                                                    // torch（带透明）
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 4;
        px[i + 3] = 0;
        const inStick = x >= 7 && x <= 8 && y >= 6;
        const inHead = x >= 6 && x <= 9 && y >= 2 && y < 6;
        if (inHead) {
          const hot = r() * 30;
          px[i] = 255; px[i + 1] = 190 + hot; px[i + 2] = 60; px[i + 3] = 255;
        } else if (inStick) {
          const n = r() * 20;
          px[i] = 110 + n; px[i + 1] = 76 + n; px[i + 2] = 40; px[i + 3] = 255;
        }
      }
    }
  },
  speckle([122, 122, 126], 14, mulberry32(6), (x, y, r) =>                        // ore
    r() < 0.12 ? [64, 190, 210] : null),
  speckle([90, 90, 96], 10, mulberry32(7)),                                       // spare
];

export function buildAtlas(): HTMLCanvasElement {
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_W; atlas.height = ATLAS_H;
  const ctx = atlas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  painters.forEach((paint, i) => {
    const tile = makeTile(paint, SEED + i * 777);
    const ox = i * CELL + PAD;
    const oy = PAD;
    // 中心
    ctx.drawImage(tile, ox, oy);
    // 四条边：边缘像素拉伸进 padding
    ctx.drawImage(tile, 0, 0, TILE, 1, ox, 0, TILE, PAD);                    // 上
    ctx.drawImage(tile, 0, TILE - 1, TILE, 1, ox, oy + TILE, TILE, PAD);     // 下
    ctx.drawImage(tile, 0, 0, 1, TILE, i * CELL, oy, PAD, TILE);             // 左
    ctx.drawImage(tile, TILE - 1, 0, 1, TILE, ox + TILE, oy, PAD, TILE);     // 右
    // 四角
    ctx.drawImage(tile, 0, 0, 1, 1, i * CELL, 0, PAD, PAD);
    ctx.drawImage(tile, TILE - 1, 0, 1, 1, ox + TILE, 0, PAD, PAD);
    ctx.drawImage(tile, 0, TILE - 1, 1, 1, i * CELL, oy + TILE, PAD, PAD);
    ctx.drawImage(tile, TILE - 1, TILE - 1, 1, 1, ox + TILE, oy + TILE, PAD, PAD);
  });
  return atlas;
}

// tile 内 UV（u,v ∈ [0,1]，v=1 是 tile 顶部）换算到图集坐标，内缩半像素。
export function tileUV(tile: number, u: number, v: number): [number, number] {
  const tx = tile * CELL + PAD + 0.5 + u * (TILE - 1);
  const ty = PAD + 0.5 + (1 - v) * (TILE - 1);
  return [tx / ATLAS_W, ty / ATLAS_H];
}
