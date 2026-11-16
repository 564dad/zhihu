// 世界存储与地形生成：3×3 个 32³ 区块拼成 96×32×96 的地下世界。
// 外圈 2 格基岩封死，y=0 封底；地表在下，洞穴靠 3D 噪声掏空，竖井从地表直通地下二层。
import { B, SEED, WX, WY, WZ, idx, inBounds, isTransparent } from './config';
import { fbm2, hash3, mulberry32, noise3 } from './rng';

export type Edit = [number, number, number, number]; // x,y,z,blockId

export class World {
  readonly blocks = new Uint8Array(WX * WY * WZ);
  /** 相对生成结果的编辑记录（挖掉/插火把），用于刷新后恢复 */
  readonly edits: Edit[] = [];
  onEdit: ((e: Edit) => void) | null = null;

  get(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return B.BORDER; // 界外视为不透明，不生成面
    return this.blocks[idx(x, y, z)];
  }

  isOpaque(x: number, y: number, z: number): boolean {
    return !isTransparent(this.get(x, y, z));
  }

  /** 游戏内编辑：记录并通知持久化 */
  setBlock(x: number, y: number, z: number, id: number): void {
    this.blocks[idx(x, y, z)] = id;
    const e: Edit = [x, y, z, id];
    this.edits.push(e);
    this.onEdit?.(e);
  }

  /** 启动时回放编辑，不重复记录 */
  applyEditRaw(x: number, y: number, z: number, id: number): void {
    this.blocks[idx(x, y, z)] = id;
  }

  generate(): void {
    const rand = mulberry32(SEED);

    // 1) 地表高度 + 基础地层
    const height = new Float32Array(WX * WZ);
    for (let z = 0; z < WZ; z++) {
      for (let x = 0; x < WX; x++) {
        const h = Math.round(25 + fbm2(x * 0.06, z * 0.06, SEED, 3) * 3);
        height[z * WX + x] = h;
        for (let y = 0; y < WY; y++) {
          let id: number = B.AIR;
          if (y === 0) id = B.BORDER;
          else if (y < h - 3) id = B.STONE;
          else if (y < h) id = B.DIRT;
          else if (y === h) id = B.GRASS;
          this.blocks[idx(x, y, z)] = id;
        }
      }
    }

    // 2) 外圈 2 格基岩封死（顶也封到 31，人出不去）
    for (let z = 0; z < WZ; z++) {
      for (let x = 0; x < WX; x++) {
        if (x < 2 || x >= WX - 2 || z < 2 || z >= WZ - 2) {
          for (let y = 0; y < WY; y++) this.blocks[idx(x, y, z)] = B.BORDER;
        }
      }
    }

    // 3) 洞穴：|noise| 管状隧道 + 低频大洞腔，只在地表以下挖
    for (let z = 2; z < WZ - 2; z++) {
      for (let x = 2; x < WX - 2; x++) {
        const h = height[z * WX + x];
        for (let y = 2; y < h - 3; y++) {
          const tunnel = noise3(x * 0.09, y * 0.11, z * 0.09, SEED + 11);
          const room = noise3(x * 0.03, y * 0.04, z * 0.03, SEED + 22);
          if (Math.abs(tunnel) < 0.075 || room > 0.62) {
            this.blocks[idx(x, y, z)] = B.AIR;
          }
        }
      }
    }

    // 4) 竖井：3 口，从地表捅到地下二层，井底掏一个洞腔接上洞穴
    const shafts: Array<[number, number, number]> = []; // x,z,r
    for (let i = 0; i < 3; i++) {
      const sx = 20 + Math.floor(rand() * (WX - 40));
      const sz = 20 + Math.floor(rand() * (WZ - 40));
      const r = 1.6 + rand() * 0.7;
      shafts.push([sx, sz, r]);
      const bottom = 5 + Math.floor(rand() * 4);
      for (let z = 0; z < WZ; z++) {
        for (let x = 0; x < WX; x++) {
          const d = Math.hypot(x + 0.5 - sx, z + 0.5 - sz);
          if (d > r) continue;
          for (let y = bottom; y < WY; y++) this.blocks[idx(x, y, z)] = B.AIR;
          // 井底洞腔
          for (let y = Math.max(2, bottom - 5); y < bottom + 2; y++) {
            if (d < r + 2.5) this.blocks[idx(x, y, z)] = B.AIR;
          }
        }
      }
    }

    // 5) 矿石点缀（深层石头里）
    for (let z = 2; z < WZ - 2; z++) {
      for (let x = 2; x < WX - 2; x++) {
        for (let y = 2; y < 16; y++) {
          const i = idx(x, y, z);
          if (this.blocks[i] === B.STONE && hash3(x, y, z, SEED + 33) < 0.02) {
            this.blocks[i] = B.ORE;
          }
        }
      }
    }
  }

  /** 找地表落脚点（出生用） */
  surfaceY(x: number, z: number): number {
    for (let y = WY - 1; y > 0; y--) {
      if (this.isOpaque(x, y, z)) return y + 1;
    }
    return WY - 1;
  }
}
