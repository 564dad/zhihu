// 入口：世界生成 -> 编辑回放 -> 全量光照 -> 全量网格 -> 主循环。
// 编辑走增量光照 + 脏区块重建（每帧限量，避免挖掘时卡顿）。
import { mat4, vec3 } from 'gl-matrix';
import { B, CHUNKS_X, CHUNKS_Z, SEED, WY } from './config';
import { World } from './world';
import { LightEngine } from './light';
import { buildChunkMesh } from './mesher';
import { Renderer } from './renderer';
import { Player } from './player';

const STORAGE_KEY = `voxel-cave-edits-${SEED}`;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const debugEl = document.getElementById('debug') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;

const renderer = new Renderer(canvas);
const world = new World();
world.generate();

// 刷新后恢复挖掉的方块和火把
const saved = localStorage.getItem(STORAGE_KEY);
if (saved) {
  try {
    for (const [x, y, z, id] of JSON.parse(saved) as Array<[number, number, number, number]>) {
      world.applyEditRaw(x, y, z, id);
    }
  } catch { /* 数据坏了就当没有 */ }
}
world.onEdit = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(world.edits));
};

const light = new LightEngine(world);
light.computeAll();

// 网格重建统计（F3 用）
const stats = { rebuilds: 0, lastMs: 0, fps: 0 };

function rebuildChunk(key: number): void {
  const cx = key % CHUNKS_X;
  const cz = Math.floor(key / CHUNKS_X);
  const t0 = performance.now();
  const mesh = buildChunkMesh(world, light, cx, cz);
  renderer.uploadChunk(key, mesh);
  stats.lastMs = performance.now() - t0;
  stats.rebuilds++;
}

function rebuildAll(): void {
  for (let cz = 0; cz < CHUNKS_Z; cz++) {
    for (let cx = 0; cx < CHUNKS_X; cx++) rebuildChunk(cx + cz * CHUNKS_X);
  }
  light.dirtyChunks.clear();
}
rebuildAll();

// 出生点：世界中心地表
const player = new Player();
player.pos.x = 48.5;
player.pos.z = 48.5;
player.pos.y = world.surfaceY(48, 48) + 0.01;

// ---- 输入 ----
const keys = new Set<string>();
let debugOn = false;

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  hintEl.style.display = document.pointerLockElement === canvas ? 'none' : '';
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * 0.0025;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * 0.0025));
});
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'F3') { e.preventDefault(); debugOn = !debugOn; debugEl.style.display = debugOn ? '' : 'none'; }
  if (e.code === 'KeyF') player.fly = !player.fly;
});
document.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const hit = player.raycast(world, 6);
  if (!hit) return;
  if (e.button === 0) {
    // 挖（基岩不可挖）
    const id = world.get(hit.x, hit.y, hit.z);
    if (id === B.BORDER) return;
    world.setBlock(hit.x, hit.y, hit.z, B.AIR);
    light.onBlockChanged(hit.x, hit.y, hit.z, B.AIR);
  } else if (e.button === 2) {
    // 在命中面的空格插火把
    const id = world.get(hit.px, hit.py, hit.pz);
    if (id === B.AIR && hit.py > 0 && hit.py < WY) {
      world.setBlock(hit.px, hit.py, hit.pz, B.TORCH);
      light.onBlockChanged(hit.px, hit.py, hit.pz, B.TORCH);
    }
  }
});

// ---- 主循环 ----
const proj = mat4.create();
const view = mat4.create();
const vp = mat4.create();
const eye = vec3.create();
const center = vec3.create();
const up = vec3.fromValues(0, 1, 0);

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fpsTimer = 0;

function frame(now: number): void {
  // 切标签页回来 dt 会很大，钳住避免穿墙/白屏感
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  player.update(dt, keys, world);

  // context 恢复后全量重建
  if (renderer.needsFullRebuild) {
    renderer.needsFullRebuild = false;
    rebuildAll();
  }
  // 增量重建脏区块，每帧最多 2 个，控制单帧耗时
  let budget = 2;
  for (const key of light.dirtyChunks) {
    if (budget-- <= 0) break;
    light.dirtyChunks.delete(key);
    rebuildChunk(key);
  }

  const aspect = canvas.width / Math.max(1, canvas.height);
  mat4.perspective(proj, (75 * Math.PI) / 180, aspect, 0.1, 200);
  vec3.set(eye, player.pos.x, player.eyeY, player.pos.z);
  const [lx, ly, lz] = player.lookDir();
  vec3.set(center, eye[0] + lx, eye[1] + ly, eye[2] + lz);
  mat4.lookAt(view, eye, center, up);
  mat4.multiply(vp, proj, view);
  renderer.render(vp, player.eyeY);

  // FPS 与调试信息
  fpsAcc += dt; fpsFrames++; fpsTimer += dt;
  if (fpsTimer > 0.25) {
    stats.fps = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0; fpsFrames = 0; fpsTimer = 0;
    if (debugOn) {
      debugEl.textContent =
        `FPS ${stats.fps} | 区块 ${renderer.chunkCount} | 网格重建 ${stats.rebuilds} 次 | ` +
        `单次 ${stats.lastMs.toFixed(2)}ms | 待重建 ${light.dirtyChunks.size}\n` +
        `pos ${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}, ${player.pos.z.toFixed(1)}` +
        `${player.fly ? ' | FLY' : ''}`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 调试/自动化测试钩子
(window as unknown as { __game: unknown }).__game = { player, world, light, stats };
