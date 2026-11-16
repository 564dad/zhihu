// 区块网格化：逐方块做面剔除，逐顶点平滑光照（取面外 4 个空气格的平均）
// + 简单顶点 AO。火把是两张交叉面片，双面。
import { B, CHUNK, WY, idx } from './config';
import { T, tileUV } from './atlas';
import type { World } from './world';
import type { LightEngine } from './light';

export interface ChunkMesh {
  verts: Float32Array; // 每顶点 8 float: x,y,z, u,v, sky,block, ao
  inds: Uint32Array;
}

interface Face {
  dir: [number, number, number];
  corners: Array<{ pos: [number, number, number]; uv: [number, number] }>;
}

const FACES: Face[] = [
  { dir: [-1, 0, 0], corners: [
    { pos: [0, 1, 0], uv: [0, 1] }, { pos: [0, 0, 0], uv: [0, 0] },
    { pos: [0, 1, 1], uv: [1, 1] }, { pos: [0, 0, 1], uv: [1, 0] } ] },
  { dir: [1, 0, 0], corners: [
    { pos: [1, 1, 1], uv: [0, 1] }, { pos: [1, 0, 1], uv: [0, 0] },
    { pos: [1, 1, 0], uv: [1, 1] }, { pos: [1, 0, 0], uv: [1, 0] } ] },
  { dir: [0, -1, 0], corners: [
    { pos: [1, 0, 1], uv: [1, 0] }, { pos: [0, 0, 1], uv: [0, 0] },
    { pos: [1, 0, 0], uv: [1, 1] }, { pos: [0, 0, 0], uv: [0, 1] } ] },
  { dir: [0, 1, 0], corners: [
    { pos: [0, 1, 1], uv: [1, 1] }, { pos: [1, 1, 1], uv: [0, 1] },
    { pos: [0, 1, 0], uv: [1, 0] }, { pos: [1, 1, 0], uv: [0, 0] } ] },
  { dir: [0, 0, -1], corners: [
    { pos: [1, 0, 0], uv: [0, 0] }, { pos: [0, 0, 0], uv: [1, 0] },
    { pos: [1, 1, 0], uv: [0, 1] }, { pos: [0, 1, 0], uv: [1, 1] } ] },
  { dir: [0, 0, 1], corners: [
    { pos: [0, 0, 1], uv: [0, 0] }, { pos: [1, 0, 1], uv: [1, 0] },
    { pos: [0, 1, 1], uv: [0, 1] }, { pos: [1, 1, 1], uv: [1, 1] } ] },
];

const AO_TABLE = [0.45, 0.65, 0.82, 1.0];

function tileFor(block: number, dy: number): number {
  switch (block) {
    case B.STONE: return T.STONE;
    case B.DIRT: return T.DIRT;
    case B.GRASS: return dy > 0 ? T.GRASS_TOP : dy < 0 ? T.DIRT : T.GRASS_SIDE;
    case B.BORDER: return T.BORDER;
    case B.ORE: return T.ORE;
    default: return T.STONE;
  }
}

export function buildChunkMesh(world: World, light: LightEngine, cx: number, cz: number): ChunkMesh {
  const verts: number[] = [];
  const inds: number[] = [];
  const x0 = cx * CHUNK, z0 = cz * CHUNK;

  for (let y = 0; y < WY; y++) {
    for (let z = z0; z < z0 + CHUNK; z++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        const id = world.blocks[idx(x, y, z)];
        if (id === B.AIR) continue;

        if (id === B.TORCH) {
          // 交叉面片，双面，光照取本格
          const s = light.getSky(x, y, z);
          const b = light.getBlock(x, y, z);
          const quads: Array<Array<[number, number, number]>> = [
            [[0.25, 0, 0.25], [0.75, 0, 0.75], [0.25, 0.75, 0.25], [0.75, 0.75, 0.75]],
            [[0.75, 0, 0.25], [0.25, 0, 0.75], [0.75, 0.75, 0.25], [0.25, 0.75, 0.75]],
          ];
          for (const q of quads) {
            for (let rev = 0; rev < 2; rev++) {
              const base = verts.length / 8;
              const uvs: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];
              for (let k = 0; k < 4; k++) {
                const p = q[k];
                const [u, v] = tileUV(T.TORCH, uvs[k][0], uvs[k][1]);
                verts.push(x + p[0], y + p[1], z + p[2], u, v, s, b, 1);
              }
              if (rev === 0) inds.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
              else inds.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
            }
          }
          continue;
        }

        for (const face of FACES) {
          const [dx, dy, dz] = face.dir;
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (world.isOpaque(nx, ny, nz)) continue;
          const tile = tileFor(id, dy);
          const base = verts.length / 8;

          for (const corner of face.corners) {
            const [px, py, pz] = corner.pos;
            // 切向两轴上的偏移（±1），用于采平滑光照的 4 个邻格
            const t1: [number, number, number] = [dx === 0 ? (px ? 1 : -1) : 0, dy === 0 ? (py ? 1 : -1) : 0, dz === 0 ? (pz ? 1 : -1) : 0];
            // t1 现在含两个切向分量，拆开
            const axes: Array<[number, number, number]> = [];
            if (dx === 0) axes.push([t1[0], 0, 0]);
            if (dy === 0) axes.push([0, t1[1], 0]);
            if (dz === 0) axes.push([0, 0, t1[2]]);
            const [a1, a2] = axes;
            const bx = nx, by = ny, bz = nz;
            const s1x = bx + a1[0], s1y = by + a1[1], s1z = bz + a1[2];
            const s2x = bx + a2[0], s2y = by + a2[1], s2z = bz + a2[2];
            const ccx = bx + a1[0] + a2[0], ccy = by + a1[1] + a2[1], ccz = bz + a1[2] + a2[2];

            const sky = (light.getSky(bx, by, bz) + light.getSky(s1x, s1y, s1z) +
                         light.getSky(s2x, s2y, s2z) + light.getSky(ccx, ccy, ccz)) / 4;
            const blk = (light.getBlock(bx, by, bz) + light.getBlock(s1x, s1y, s1z) +
                         light.getBlock(s2x, s2y, s2z) + light.getBlock(ccx, ccy, ccz)) / 4;

            const o1 = world.isOpaque(s1x, s1y, s1z) ? 1 : 0;
            const o2 = world.isOpaque(s2x, s2y, s2z) ? 1 : 0;
            const oc = world.isOpaque(ccx, ccy, ccz) ? 1 : 0;
            const aoLevel = (o1 && o2) ? 0 : 3 - (o1 + o2 + oc);
            const ao = AO_TABLE[aoLevel];

            const [u, v] = tileUV(tile, corner.uv[0], corner.uv[1]);
            verts.push(x + px, y + py, z + pz, u, v, sky, blk, ao);
          }
          inds.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
        }
      }
    }
  }
  return { verts: new Float32Array(verts), inds: new Uint32Array(inds) };
}
