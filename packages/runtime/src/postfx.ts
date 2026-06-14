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
import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  NearestFilter,
  RGBAFormat,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import type { Camera, Data3DTexture, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { TexturePass } from "three/addons/postprocessing/TexturePass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { LUTPass } from "three/addons/postprocessing/LUTPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

// Depth of field — a self-contained depth-texture pass. Reads the scene color +
// a populated depth texture and blurs by circle-of-confusion. Unlike three's
// BokehPass it does NOT re-render the scene with an override material (which on
// `Points` particles leaves gl_PointSize undefined → non-deterministic depth).
// Stateless + a pure function of (uv, color, depth) → seek-idempotent.
const DofShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 200.0 },
    focusDistance: { value: 5.0 },
    focusRange: { value: 2.0 },
    maxBlur: { value: 0.015 },
    texelSize: { value: new Vector2(1 / 1920, 1 / 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, focusDistance, focusRange, maxBlur;
    uniform vec2 texelSize;
    varying vec2 vUv;
    // perspective depth (0..1) → positive view-space distance from camera
    float viewDist(float d){
      float z = d * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
    }
    float coc(float dist){ return clamp(abs(dist - focusDistance) / max(focusRange, 1e-3), 0.0, 1.0); }
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      float radius = coc(viewDist(texture2D(tDepth, vUv).x)) * maxBlur;
      if (radius < texelSize.x * 0.75) { gl_FragColor = base; return; }
      const int TAPS = 24;
      const float GA = 2.39996323; // golden angle
      float ratio = texelSize.y / texelSize.x; // keep the disk circular on a wide buffer
      vec4 sum = base;
      float wsum = 1.0;
      for (int i = 0; i < TAPS; i++){
        float fi = float(i) + 0.5;
        float r = sqrt(fi / float(TAPS)) * radius;
        float a = fi * GA;
        vec2 suv = clamp(vUv + vec2(cos(a), sin(a) * ratio) * r, vec2(0.0), vec2(1.0));
        // depth-aware weight: out-of-focus samples contribute, sharp ones don't —
        // stops the in-focus subject bleeding outward.
        float w = coc(viewDist(texture2D(tDepth, suv).x));
        sum += texture2D(tDiffuse, suv) * w;
        wsum += w;
      }
      gl_FragColor = sum / wsum;
    }
  `,
};

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

  // Depth of field needs a sampleable depth texture, which the override-material
  // BokehPass approach can't deliver deterministically (it corrupts particle
  // depth). Instead, for DOF we render the scene ONCE into our own RT (with a
  // depth texture) and feed it to the composer via TexturePass; the DOF pass then
  // reads that known-populated depth. Non-DOF keeps the normal RenderPass chain.
  const dofFocus = new Vector3(...(opts.dofFocus ?? [0, 0, 0]));
  let sceneRT: WebGLRenderTarget | null = null;
  let dofPass: ShaderPass | null = null;
  if (wantDof) {
    const d = opts.dof ?? 0;
    sceneRT = new WebGLRenderTarget(opts.width, opts.height, {
      type: HalfFloatType,
      format: RGBAFormat,
      samples: 0, // a sampleable depth texture can't come from an MSAA target
    });
    const depthTex = new DepthTexture(opts.width, opts.height);
    depthTex.format = DepthFormat;
    depthTex.type = UnsignedIntType;
    depthTex.minFilter = NearestFilter;
    depthTex.magFilter = NearestFilter;
    sceneRT.depthTexture = depthTex;

    composer.addPass(new TexturePass(sceneRT.texture)); // scene color → composer buffer
    dofPass = new ShaderPass(DofShader);
    dofPass.uniforms.tDepth.value = sceneRT.depthTexture;
    dofPass.uniforms.maxBlur.value = 0.006 + d * 0.022;
    dofPass.uniforms.focusRange.value = 2.0 - d * 1.5; // shallower band as dof→1
    dofPass.uniforms.texelSize.value = new Vector2(1 / opts.width, 1 / opts.height);
    composer.addPass(dofPass);
  } else {
    const renderPass = new RenderPass(scene, camera);
    renderPass.clearAlpha = 0;
    composer.addPass(renderPass);
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
      if (sceneRT && dofPass) {
        // Single full-scene render into our depth-texture RT (replaces RenderPass
        // AND BokehPass's depth render). Then the composer's TexturePass + DOF run.
        renderer.setRenderTarget(sceneRT);
        renderer.setClearColor(0x000000, 0); // keep transparent scenes transparent
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        dofPass.uniforms.focusDistance.value = cam.position.distanceTo(dofFocus);
        dofPass.uniforms.cameraNear.value = cam.near;
        dofPass.uniforms.cameraFar.value = cam.far;
      }
      composer.render(0); // explicit delta — never reads the wall clock
    },
    setSize: (w, h) => {
      composer.setSize(w, h);
      if (sceneRT) {
        sceneRT.setSize(w, h);
        if (dofPass) dofPass.uniforms.texelSize.value = new Vector2(1 / w, 1 / h);
      }
    },
    setLUT: (texture, intensity) => {
      if (!lutPass) return;
      lutPass.lut = texture;
      lutPass.intensity = intensity;
      lutPass.enabled = true;
    },
  };
}
