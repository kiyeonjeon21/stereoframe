/**
 * Post-processing — the cinematic "finish" pass. Bloom, depth of field,
 * chromatic aberration, film grain, a light grade, and a vignette, all
 * deterministic and seekable: every time-driven pass derives from the seek
 * time `t` (passed to `render(t)`), never a wall clock; the rest are
 * stateless single-frame effects.
 *
 * Antialiasing is supersampling (scene.ts renders the canvas at Nx and the
 * capture downsamples) — handled outside this chain.
 */
import { HalfFloatType, RGBAFormat, Vector2, Vector3, WebGLRenderTarget } from "three";
import type { Camera, Data3DTexture, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { LUTPass } from "three/addons/postprocessing/LUTPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const VignetteGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 0.0 },
    contrast: { value: 1.0 },
    saturation: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float contrast;
    uniform float saturation;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // contrast around mid-grey, then saturation
      c = (c - 0.5) * contrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      // vignette
      vec2 uv = (vUv - 0.5) * 1.1;
      float vig = clamp(1.0 - dot(uv, uv), 0.0, 1.0);
      c *= mix(1.0, vig, vignette);
      gl_FragColor = vec4(c, texture2D(tDiffuse, vUv).a);
    }
  `,
};

const ChromaticAberrationShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float d = dot(dir, dir);
      vec2 off = dir * d * amount;
      float r = texture2D(tDiffuse, vUv - off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + off).b;
      float a = texture2D(tDiffuse, vUv).a;
      gl_FragColor = vec4(r, g, b, a);
    }
  `,
};

const GrainShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.0 }, uTime: { value: 0.0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float uTime;
    varying vec2 vUv;
    // sin-free hash → identical for a given (uv, t), so seekable
    float hash(vec2 p){
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float g = hash(vUv * vec2(1920.0, 1080.0) + uTime * 73.0) - 0.5;
      gl_FragColor = vec4(src.rgb + g * amount, src.a);
    }
  `,
};

export interface PostFXOptions {
  width: number;
  height: number;
  bloom?: number;
  bloomThreshold?: number;
  bloomRadius?: number;
  vignette?: number;
  contrast?: number;
  saturation?: number;
  chromaticAberration?: number;
  grain?: number;
  /** Depth-of-field strength (0 = off). Focus auto-tracks `dofFocus` each frame,
   *  so the subject stays sharp while fore/background blur — deterministic (the
   *  blur is depth-based, focus is a pure function of the camera position = f(t)). */
  dof?: number;
  /** World point the DOF keeps in focus (default origin = the auto-fit subject). */
  dofFocus?: [number, number, number];
  /** A .cube LUT is wanted (texture arrives async via setLUT). */
  lut?: boolean;
  lutIntensity?: number;
  /** MSAA samples on the render target (WebGL2) — hardware edge AA for thin geometry. */
  msaa?: number;
}

export interface PostFX {
  /** t drives the grain + DOF focus (and any future time-based pass); pure function of t. */
  render: (t: number) => void;
  setSize: (w: number, h: number) => void;
  /** Wire in a loaded .cube LUT (loaded asynchronously by the scene). */
  setLUT: (texture: Data3DTexture, intensity: number) => void;
}

export function buildPostFX(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  opts: PostFXOptions,
): PostFX | null {
  const wantBloom = (opts.bloom ?? 0) > 0;
  const wantVignette = (opts.vignette ?? 0) > 0;
  const wantGrade = (opts.contrast ?? 1) !== 1 || (opts.saturation ?? 1) !== 1;
  const wantChroma = (opts.chromaticAberration ?? 0) > 0;
  const wantGrain = (opts.grain ?? 0) > 0;
  const wantDof = (opts.dof ?? 0) > 0;
  const wantLut = opts.lut === true;
  if (!wantBloom && !wantVignette && !wantGrade && !wantChroma && !wantGrain && !wantDof && !wantLut) {
    return null;
  }

  // Alpha-capable render target + clearAlpha 0 so a transparent scene stays
  // transparent through the chain (DOM-occlusion compositions can use post-fx).
  // Default EffectComposer targets + RenderPass clear opaque black otherwise.
  const target = new WebGLRenderTarget(opts.width, opts.height, {
    type: HalfFloatType,
    format: RGBAFormat,
    samples: Math.max(0, opts.msaa ?? 0), // MSAA (WebGL2) — hardware edge AA for thin geometry
  });
  const composer = new EffectComposer(renderer, target);
  composer.setSize(opts.width, opts.height);
  const renderPass = new RenderPass(scene, camera);
  renderPass.clearAlpha = 0;
  composer.addPass(renderPass);

  // Depth of field — added right after the scene render so it has fresh depth.
  // `dof` (0..1) maps to aperture + max blur; focus distance is set per-frame in
  // render(t) from the camera→subject distance (so the subject stays sharp).
  let bokehPass: BokehPass | null = null;
  const dofFocus = new Vector3(...(opts.dofFocus ?? [0, 0, 0]));
  if (wantDof) {
    const d = opts.dof ?? 0;
    bokehPass = new BokehPass(scene, camera, {
      focus: 5.0,
      aperture: d * 0.03, // shallower depth-of-field as dof→1
      maxblur: 0.006 + d * 0.022, // max circle-of-confusion radius (fraction of screen)
    });
    composer.addPass(bokehPass);
  }

  if (wantBloom) {
    composer.addPass(
      new UnrealBloomPass(
        new Vector2(opts.width, opts.height),
        opts.bloom ?? 0.6,
        opts.bloomRadius ?? 0.6,
        opts.bloomThreshold ?? 0.85,
      ),
    );
  }
  if (wantChroma) {
    const pass = new ShaderPass(ChromaticAberrationShader);
    pass.uniforms.amount.value = opts.chromaticAberration;
    composer.addPass(pass);
  }
  let grainPass: ShaderPass | null = null;
  if (wantGrain) {
    grainPass = new ShaderPass(GrainShader);
    grainPass.uniforms.amount.value = opts.grain;
    composer.addPass(grainPass);
  }
  if (wantVignette || wantGrade) {
    const pass = new ShaderPass(VignetteGradeShader);
    pass.uniforms.vignette.value = opts.vignette ?? 0;
    pass.uniforms.contrast.value = opts.contrast ?? 1;
    pass.uniforms.saturation.value = opts.saturation ?? 1;
    composer.addPass(pass);
  }
  composer.addPass(new OutputPass());

  // .cube LUT grade — display-referred, so it runs last (after OutputPass'
  // tone-map + sRGB). Created disabled; the scene loads the .cube async and calls
  // setLUT, which enables it. EffectComposer routes the last *enabled* pass to the
  // screen, so OutputPass stays the output until the LUT is ready.
  let lutPass: LUTPass | null = null;
  if (wantLut) {
    lutPass = new LUTPass({ intensity: opts.lutIntensity ?? 1 });
    lutPass.enabled = false;
    composer.addPass(lutPass);
  }

  const cam = camera as PerspectiveCamera;
  return {
    render: (t: number) => {
      if (grainPass) grainPass.uniforms.uTime.value = t;
      if (bokehPass) bokehPass.uniforms["focus"].value = cam.position.distanceTo(dofFocus);
      composer.render(0); // explicit delta — never reads the wall clock
    },
    setSize: (w, h) => composer.setSize(w, h),
    setLUT: (texture, intensity) => {
      if (!lutPass) return;
      lutPass.lut = texture;
      lutPass.intensity = intensity;
      lutPass.enabled = true;
    },
  };
}
