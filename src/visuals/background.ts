import type { SamplerEngine, TriggerEvent } from '../audio/engine';
import { sliceHue } from '../ui/waveform';
import { FeatureTracker } from './features';

/**
 * Full-window WebGL layer behind the UI. It only reads the engine's analyser
 * and trigger events, so it never touches audio scheduling; a slow frame just
 * drops a frame of visuals.
 *
 * - bass swells a glow from the bottom and zooms the flow field
 * - mids speed up and warp the flow
 * - highs add fine sparkle
 * - every slice hit sends out a ring in that slice's colour, at a fixed spot
 *   per slice, timed to when the note is actually heard
 */

const MAX_HITS = 12;
const HIT_LIFE = 1.6; // seconds
const RES_SCALE = 0.6; // render below CSS resolution; it's all soft shapes

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime, uBass, uMid, uHigh, uLevel, uKick;
uniform vec4 uHits[${MAX_HITS}]; // xy position, age (s, <0 = not yet), velocity
uniform float uHue[${MAX_HITS}];
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}
vec3 hue(float h) {
  vec3 k = clamp(abs(mod(h / 60.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return k;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // flow field: domain-warped noise, zoomed by bass, stirred by mids
  float t = uTime * (0.04 + 0.1 * uMid);
  vec2 q = p * (1.6 - 0.35 * uBass);
  vec2 w = vec2(fbm(q + t), fbm(q - t + 5.2));
  float n = fbm(q + 1.8 * w + vec2(t * 0.7, -t));

  vec3 base = vec3(0.055, 0.063, 0.075);
  vec3 deep = vec3(0.09, 0.14, 0.24);
  vec3 amber = vec3(1.0, 0.71, 0.28);
  vec3 col = base + deep * smoothstep(0.35, 0.85, n) * (0.5 + 0.9 * uLevel);
  col += amber * pow(smoothstep(0.55, 0.95, n), 2.0) * (0.06 + 0.35 * uMid);

  // bass glow rising from the bottom edge
  float glow = exp(-3.2 * uv.y) * (0.25 * uBass + 0.35 * uKick);
  col += amber * glow * (0.6 + 0.4 * w.x);

  // slice hits: rings in the slice's colour
  for (int i = 0; i < ${MAX_HITS}; i++) {
    vec4 h = uHits[i];
    if (h.z < 0.0 || h.z > ${HIT_LIFE.toFixed(2)}) continue;
    vec2 c = (h.xy - 0.5) * vec2(aspect, 1.0);
    float d = length(p - c);
    float r = 0.05 + h.z * 0.55;
    float fade = pow(1.0 - h.z / ${HIT_LIFE.toFixed(2)}, 2.0) * h.w;
    float ring = exp(-pow((d - r) * 28.0, 2.0));
    float core = exp(-d * d * 60.0) * exp(-h.z * 7.0);
    col += hue(uHue[i]) * (0.55 * ring + 0.8 * core) * fade;
  }

  // high-end sparkle
  float s = hash(floor(frag / 2.0) + floor(uTime * 24.0));
  col += vec3(0.8, 0.85, 1.0) * step(0.9985 - 0.002 * uHigh, s) * uHigh * 0.45;

  // vignette keeps the edges calm behind the panels
  col *= 1.0 - 0.55 * dot(p / vec2(aspect, 1.0), p / vec2(aspect, 1.0)) * 1.6;
  o = vec4(col, 1.0);
}`;

interface Hit {
  x: number;
  y: number;
  time: number;
  velocity: number;
  hue: number;
}

/** Fixed, well-spread spot for each slice (golden-ratio sequence). */
export function hitPosition(index: number) {
  return {
    x: 0.1 + 0.8 * ((index * 0.6180339887 + 0.27) % 1),
    y: 0.15 + 0.7 * ((index * 0.7548776662 + 0.53) % 1),
  };
}

export class Background {
  readonly supported: boolean;
  private gl: WebGL2RenderingContext | null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private tracker = new FeatureTracker();
  private spectrum: Uint8Array<ArrayBuffer>;
  private hits: Hit[] = [];
  private raf = 0;
  private last = 0;
  private enabled = false;
  private hitData = new Float32Array(MAX_HITS * 4);
  private hueData = new Float32Array(MAX_HITS);

  private canvas: HTMLCanvasElement;
  private engine: SamplerEngine;

  constructor(canvas: HTMLCanvasElement, engine: SamplerEngine) {
    this.canvas = canvas;
    this.engine = engine;
    engine.analyser.smoothingTimeConstant = 0.55; // snappier than the 0.8 default
    this.spectrum = new Uint8Array(engine.analyser.frequencyBinCount);
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    this.supported = !!this.gl && this.init(this.gl);
    engine.onTrigger((e) => this.onHit(e));
    window.addEventListener('resize', () => this.resize());
  }

  get on() {
    return this.enabled;
  }

  setEnabled(on: boolean) {
    this.enabled = on && this.supported;
    this.canvas.hidden = !this.enabled;
    cancelAnimationFrame(this.raf);
    if (this.enabled) {
      this.resize();
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private onHit(e: TriggerEvent) {
    if (!this.enabled) return;
    const { x, y } = hitPosition(e.sliceIndex);
    this.hits.push({ x, y, time: e.time, velocity: e.velocity, hue: sliceHue(e.sliceIndex) });
    if (this.hits.length > MAX_HITS) this.hits.shift();
  }

  private init(gl: WebGL2RenderingContext) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('Visuals disabled:', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const u of ['uRes', 'uTime', 'uBass', 'uMid', 'uHigh', 'uLevel', 'uKick', 'uHits', 'uHue']) {
      this.uniforms[u] = gl.getUniformLocation(prog, u);
    }
    return true;
  }

  private resize() {
    const w = Math.max(1, Math.round(window.innerWidth * RES_SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * RES_SCALE));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl?.viewport(0, 0, w, h);
  }

  private frame(now: number) {
    if (!this.enabled) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const gl = this.gl!;
    const dt = (now - this.last) / 1000;
    this.last = now;

    const { analyser, ctx } = this.engine;
    analyser.getByteFrequencyData(this.spectrum);
    const f = this.tracker.update(this.spectrum, ctx.sampleRate / analyser.fftSize, dt);

    // Hits are booked ahead by the sequencer; age them against when they're heard.
    const heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    this.hits = this.hits.filter((h) => heard - h.time < HIT_LIFE);
    this.hitData.fill(-1);
    this.hits.forEach((h, i) => {
      const age = heard - h.time;
      this.hitData.set([h.x, h.y, age, h.velocity], i * 4);
      this.hueData[i] = h.hue;
      if (age >= 0 && age < dt + 0.001) this.tracker.bump(0.6 * h.velocity);
    });

    const u = this.uniforms;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, now / 1000);
    gl.uniform1f(u.uBass, f.bass);
    gl.uniform1f(u.uMid, f.mid);
    gl.uniform1f(u.uHigh, f.high);
    gl.uniform1f(u.uLevel, f.level);
    gl.uniform1f(u.uKick, f.kick);
    gl.uniform4fv(u.uHits, this.hitData);
    gl.uniform1fv(u.uHue, this.hueData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
