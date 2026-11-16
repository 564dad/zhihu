// 全局尺寸与种子。seed 写死，每次进入地形一致，方便录同一条路线。
export const SEED = 20261116;

export const CHUNK = 32;          // 区块边长（含高度，32³）
export const CHUNKS_X = 3;
export const CHUNKS_Z = 3;

export const WX = CHUNK * CHUNKS_X; // 96
export const WY = CHUNK;            // 32
export const WZ = CHUNK * CHUNKS_Z; // 96

// 方块 id
export const B = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  BORDER: 4, // 封边基岩，不可挖
  TORCH: 5,
  ORE: 6,
} as const;

export function isTransparent(id: number): boolean {
  return id === B.AIR || id === B.TORCH;
}

export function idx(x: number, y: number, z: number): number {
  return (y * WZ + z) * WX + x;
}

export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < WX && y >= 0 && y < WY && z >= 0 && z < WZ;
}
