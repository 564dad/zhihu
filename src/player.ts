// 第一人称玩家：AABB 逐轴碰撞、重力/跳跃、DDA 射线（挖方块/插火把）。
import { B, WY } from './config';
import type { World } from './world';

const HALF = 0.3;
const HEIGHT = 1.8;
const EYE = 1.62;
const GRAVITY = 22;
const JUMP = 8;
const WALK = 4.5;
const FLY = 9;

export interface RayHit {
  x: number; y: number; z: number;      // 命中的方块
  px: number; py: number; pz: number;   // 命中前的空格（放火把用）
}

export class Player {
  pos = { x: 48.5, y: 30, z: 48.5 }; // 脚底中心
  vel = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  onGround = false;
  fly = false;

  get eyeY(): number {
    return this.pos.y + EYE;
  }

  lookDir(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  private collides(world: World, px: number, py: number, pz: number): boolean {
    const x0 = Math.floor(px - HALF), x1 = Math.floor(px + HALF);
    const y0 = Math.floor(py), y1 = Math.floor(py + HEIGHT - 1e-6);
    const z0 = Math.floor(pz - HALF), z1 = Math.floor(pz + HALF);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (world.isOpaque(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  update(dt: number, keys: Set<string>, world: World): void {
    const speed = this.fly ? FLY : WALK;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (keys.has('KeyW')) { fx -= sin; fz -= cos; }
    if (keys.has('KeyS')) { fx += sin; fz += cos; }
    if (keys.has('KeyA')) { fx -= cos; fz += sin; }
    if (keys.has('KeyD')) { fx += cos; fz -= sin; }
    const len = Math.hypot(fx, fz) || 1;
    this.vel.x = (fx / len) * speed;
    this.vel.z = (fz / len) * speed;

    if (this.fly) {
      this.vel.y = 0;
      if (keys.has('Space')) this.vel.y = speed;
      if (keys.has('ShiftLeft')) this.vel.y = -speed;
    } else {
      this.vel.y -= GRAVITY * dt;
      if (keys.has('Space') && this.onGround) this.vel.y = JUMP;
    }

    // 逐轴移动 + 碰撞
    const p = this.pos;
    let nx = p.x + this.vel.x * dt;
    if (this.collides(world, nx, p.y, p.z)) nx = p.x;
    let nz = p.z + this.vel.z * dt;
    if (this.collides(world, nx, p.y, nz)) nz = p.z;
    let ny = p.y + this.vel.y * dt;
    this.onGround = false;
    if (this.collides(world, nx, ny, nz)) {
      if (this.vel.y < 0) {
        ny = Math.floor(ny) + 1;
        this.onGround = true;
      } else {
        ny = Math.floor(ny + HEIGHT) - HEIGHT - 1e-4;
      }
      this.vel.y = 0;
    }
    p.x = nx; p.y = ny; p.z = nz;
    if (p.y < 1) { p.y = 1; this.vel.y = 0; this.onGround = true; }
    if (p.y > WY + 10) p.y = WY + 10;
  }

  /** Amanatides & Woo DDA，返回第一个非空气方块 */
  raycast(world: World, maxDist: number): RayHit | null {
    const [dx, dy, dz] = this.lookDir();
    let x = Math.floor(this.pos.x);
    let y = Math.floor(this.eyeY);
    let z = Math.floor(this.pos.z);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - this.pos.x : this.pos.x - x) * tDeltaX) : Infinity;
    let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - this.eyeY : this.eyeY - y) * tDeltaY) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - this.pos.z : this.pos.z - z) * tDeltaZ) : Infinity;
    let px = x, py = y, pz = z;
    let t = 0;
    while (t <= maxDist) {
      const id = world.get(x, y, z);
      if (id !== B.AIR) return { x, y, z, px, py, pz };
      px = x; py = y; pz = z;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    }
    return null;
  }
}
