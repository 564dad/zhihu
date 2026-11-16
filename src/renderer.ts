// WebGL2 渲染器：手写 GLSL，单 program，图集纹理（NEAREST 无 mipmap，配合
// padding 保证接缝不串色）。天光冷色、火把暖色、雾密度随玩家高度变化。
// 处理 context lost/restored：恢复后整体重建 GL 资源，不白屏。
import { mat4 } from 'gl-matrix';
import { buildAtlas } from './atlas';
import type { ChunkMesh } from './mesher';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec3 aLight; // sky, block, ao
uniform mat4 uMVP;
out vec2 vUV;
out vec3 vLight;
out float vDist;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vUV = aUV;
  vLight = aLight;
  vDist = gl_Position.w;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vLight;
in float vDist;
uniform sampler2D uAtlas;
uniform vec3 uSkyTint;
uniform vec3 uTorchTint;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
out vec4 outColor;
void main() {
  vec4 tex = texture(uAtlas, vUV);
  if (tex.a < 0.5) discard;
  float sky = pow(vLight.x / 15.0, 1.3);
  float blk = pow(vLight.y / 15.0, 1.3);
  vec3 light = uAmbient + uSkyTint * sky + uTorchTint * blk;
  vec3 col = tex.rgb * light * vLight.z;
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
  outColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
}`;

interface GpuChunk {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
}

export class Renderer {
  private g!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private tex!: WebGLTexture;
  private chunks = new Map<number, GpuChunk>();
  private uMVP!: WebGLUniformLocation;
  private uSkyTint!: WebGLUniformLocation;
  private uTorchTint!: WebGLUniformLocation;
  private uAmbient!: WebGLUniformLocation;
  private uFogColor!: WebGLUniformLocation;
  private uFogDensity!: WebGLUniformLocation;
  /** context 恢复后需要重新上传全部网格 */
  needsFullRebuild = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.initGL();
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => {
      this.chunks.clear();
      this.initGL();
      this.needsFullRebuild = true;
    });
  }

  private initGL(): void {
    const gl = this.canvas.getContext('webgl2', { antialias: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 不可用');
    this.g = gl;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    }
    this.prog = prog;
    gl.useProgram(prog);
    this.uMVP = gl.getUniformLocation(prog, 'uMVP')!;
    this.uSkyTint = gl.getUniformLocation(prog, 'uSkyTint')!;
    this.uTorchTint = gl.getUniformLocation(prog, 'uTorchTint')!;
    this.uAmbient = gl.getUniformLocation(prog, 'uAmbient')!;
    this.uFogColor = gl.getUniformLocation(prog, 'uFogColor')!;
    this.uFogDensity = gl.getUniformLocation(prog, 'uFogDensity')!;

    // 图集纹理：NEAREST、无 mipmap、clamp，杜绝跨 tile 采样
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.02, 0.03, 0.05, 1);
  }

  uploadChunk(key: number, mesh: ChunkMesh): void {
    const gl = this.g;
    this.deleteChunk(key);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.inds, gl.STATIC_DRAW);
    this.chunks.set(key, { vbo, ibo, count: mesh.inds.length });
  }

  deleteChunk(key: number): void {
    const c = this.chunks.get(key);
    if (c) {
      this.g.deleteBuffer(c.vbo);
      this.g.deleteBuffer(c.ibo);
      this.chunks.delete(key);
    }
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  render(
    vp: mat4,
    camY: number,
  ): void {
    const gl = this.g;
    const w = this.canvas.clientWidth * devicePixelRatio;
    const h = this.canvas.clientHeight * devicePixelRatio;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uMVP, false, vp);

    // 暖火把 / 冷天光
    gl.uniform3f(this.uTorchTint, 1.0, 0.68, 0.38);
    gl.uniform3f(this.uSkyTint, 0.5, 0.66, 0.95);
    gl.uniform1f(this.uAmbient, 0.07);

    // 雾随高度变化：越深越浓越暗
    const depth = Math.min(1, Math.max(0, (26 - camY) / 20));
    const density = 0.012 + depth * 0.05;
    gl.uniform1f(this.uFogDensity, density);
    const fr = 0.45 * (1 - depth) + 0.01;
    const fg = 0.5 * (1 - depth) + 0.015;
    const fb = 0.62 * (1 - depth) + 0.03;
    gl.uniform3f(this.uFogColor, fr, fg, fb);
    gl.clearColor(fr, fg, fb, 1);

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const stride = 8 * 4;
    for (const c of this.chunks.values()) {
      if (c.count === 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 20);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.ibo);
      gl.drawElements(gl.TRIANGLES, c.count, gl.UNSIGNED_INT, 0);
    }
  }
}
