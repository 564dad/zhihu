// 光照引擎：天光 + 块光两个通道，各 15 级，分开存。
// 天光先按列从顶往下灌 15，再 BFS 扩散；块光从火把源点 BFS。
// 光照数据存在整张世界的数组里，BFS 队列也是全局的——跨区块边界不靠
// 事后拼接，扩散天然就越过边界流过去；边界被波及的邻区块标脏重建网格，
// 所以不会出现边界黑墙或亮边。
// 编辑后只做增量：移除泛洪（把旧光撤掉、把边界光源收进回填队列）+ 回填 BFS，
// 不重算整张图。
import { B, CHUNK, CHUNKS_X, WY, WX, WZ, idx, inBounds, isTransparent } from './config';
import type { World } from './world';

const DIRS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
] as const;

export class LightEngine {
  readonly sky = new Uint8Array(WX * WY * WZ);
  readonly block = new Uint8Array(WX * WY * WZ);
  /** 待重建网格的区块 key（cx + cz*CHUNKS_X） */
  readonly dirtyChunks = new Set<number>();

  constructor(private world: World) {}

  getSky(x: number, y: number, z: number): number {
    return inBounds(x, y, z) ? this.sky[idx(x, y, z)] : 0;
  }
  getBlock(x: number, y: number, z: number): number {
    return inBounds(x, y, z) ? this.block[idx(x, y, z)] : 0;
  }

  /** 光照变化波及的区块标脏；离边界 2 格以内时邻区块也标（平滑光照会采样过去） */
  private markDirty(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    this.dirtyChunks.add(cx + cz * CHUNKS_X);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (lx < 2 && cx > 0) this.dirtyChunks.add(cx - 1 + cz * CHUNKS_X);
    if (lx >= CHUNK - 2 && cx < CHUNKS_X - 1) this.dirtyChunks.add(cx + 1 + cz * CHUNKS_X);
    if (lz < 2 && cz > 0) this.dirtyChunks.add(cx + (cz - 1) * CHUNKS_X);
    if (lz >= CHUNK - 2 && cz < CHUNKS_X - 1) this.dirtyChunks.add(cx + (cz + 1) * CHUNKS_X);
  }

  /** 全量计算（启动时一次）：列灌天光 -> BFS；火把 -> BFS */
  computeAll(): void {
    this.sky.fill(0);
    this.block.fill(0);
    const queue: number[] = [];
    for (let z = 0; z < WZ; z++) {
      for (let x = 0; x < WX; x++) {
        for (let y = WY - 1; y >= 0; y--) {
          const i = idx(x, y, z);
          if (!isTransparent(this.world.blocks[i])) break;
          this.sky[i] = 15;
          queue.push(i);
        }
      }
    }
    this.fill(this.sky, queue, true);

    const tq: number[] = [];
    for (let z = 0; z < WZ; z++) {
      for (let x = 0; x < WX; x++) {
        for (let y = 0; y < WY; y++) {
          const i = idx(x, y, z);
          if (this.world.blocks[i] === B.TORCH) {
            this.block[i] = 14;
            tq.push(i);
          }
        }
      }
    }
    this.fill(this.block, tq, false);
  }

  /** BFS 回填：队列里是光源/候选，向更暗的透明邻居扩散 */
  private fill(channel: Uint8Array, queue: number[], isSky: boolean): void {
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const level = channel[i];
      if (level <= 1) continue;
      // 解码坐标
      const yy = Math.floor(i / (WX * WZ));
      const rem = i - yy * WX * WZ;
      const zz = Math.floor(rem / WX);
      const xx = rem - zz * WX;
      for (const [dx, dy, dz] of DIRS) {
        const nx = xx + dx, ny = yy + dy, nz = zz + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        if (!isTransparent(this.world.blocks[ni])) continue;
        // 天光竖直向下且满级时不衰减（光柱），其余 -1
        let nl = level - 1;
        if (isSky && dy === -1 && level === 15) nl = 15;
        if (channel[ni] < nl) {
          channel[ni] = nl;
          queue.push(ni);
          this.markDirty(nx, nz);
        }
      }
    }
  }

  /** 移除泛洪：从旧光源撤光，边界上更亮/同级的邻居收进回填队列 */
  private remove(channel: Uint8Array, isSky: boolean, starts: Array<[number, number]>): void {
    const rq: number[] = [];
    const rl: number[] = [];
    const fq: number[] = [];
    for (const [i, lvl] of starts) {
      channel[i] = 0;
      rq.push(i);
      rl.push(lvl);
      const yy = Math.floor(i / (WX * WZ));
      const rem = i - yy * WX * WZ;
      this.markDirty(rem % WX, Math.floor(rem / WX));
    }
    let head = 0;
    while (head < rq.length) {
      const i = rq[head];
      const lvl = rl[head];
      head++;
      const yy = Math.floor(i / (WX * WZ));
      const rem = i - yy * WX * WZ;
      const zz = Math.floor(rem / WX);
      const xx = rem - zz * WX;
      for (const [dx, dy, dz] of DIRS) {
        const nx = xx + dx, ny = yy + dy, nz = zz + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        const nl = channel[ni];
        if (nl === 0) continue;
        // 天光光柱：下方同级的 15 也是由这里灌下去的，要一起撤
        const skyPillar = isSky && dy === -1 && nl === 15 && lvl === 15;
        if (nl < lvl || skyPillar) {
          channel[ni] = 0;
          rq.push(ni);
          rl.push(nl);
          this.markDirty(nx, nz);
        } else {
          fq.push(ni); // 独立光源，待会回填
        }
      }
    }
    this.fill(channel, fq, isSky);
  }

  /** 方块编辑后的增量重算，只动受影响的一片 */
  onBlockChanged(x: number, y: number, z: number, newId: number): void {
    const i = idx(x, y, z);
    this.markDirty(x, z);
    if (isTransparent(newId)) {
      // 挖掉：先把自己残存的光撤了，再让邻居的光流进来
      if (this.sky[i] > 0) this.remove(this.sky, true, [[i, this.sky[i]]]);
      if (this.block[i] > 0) this.remove(this.block, false, [[i, this.block[i]]]);
      if (newId === B.TORCH) {
        this.block[i] = 14;
        this.fill(this.block, [i], false);
      }
      const skyQ: number[] = [];
      const blkQ: number[] = [];
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        if (this.sky[ni] > 0) skyQ.push(ni);
        if (this.block[ni] > 0) blkQ.push(ni);
      }
      this.fill(this.sky, skyQ, true);
      this.fill(this.block, blkQ, false);
    } else {
      // 放上实心方块：把这里原有的两路光撤掉（泛洪会自动从边界回填）
      if (this.sky[i] > 0) this.remove(this.sky, true, [[i, this.sky[i]]]);
      if (this.block[i] > 0) this.remove(this.block, false, [[i, this.block[i]]]);
    }
  }
}
