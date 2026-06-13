/**
 * Post-processing — the "finish" pass that separates a tech demo from a
 * polished frame: bloom (glow on highlights), vignette, and a cinematic
 * tone/output pass, all deterministic.
 *
 * Antialiasing is handled separately by supersampling (scene.ts renders the
 * canvas at Nx and the capture downsamples) — fully deterministic, unlike
 * driver MSAA. Bloom (UnrealBloomPass) and the vignette shader are stateless,
 * so the composite stays a pure function of the current frame.
 */
import { Vector2 } from "three";
import type { Camera, Scene, WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    offset: { value: 1.1 },
    darkness: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float offset;
    uniform float darkness;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 uv = (vUv - 0.5) * offset;
      float vig = clamp(1.0 - dot(uv, uv), 0.0, 1.0);
      gl_FragColor = vec4(color.rgb * mix(1.0, vig, darkness), color.a);
    }
  `,
};

export interface PostFXOptions {
  /** Buffer width/height (already includes the supersample factor). */
  width: number;
  height: number;
  /** Bloom strength; 0/undefined disables bloom. */
  bloom?: number;
  bloomThreshold?: number;
  bloomRadius?: number;
  /** Vignette darkness 0..1; 0/undefined disables it. */
  vignette?: number;
}

export interface PostFX {
  render: () => void;
  setSize: (w: number, h: number) => void;
}

/** Returns a post chain, or null when no effect is requested (caller renders directly). */
export function buildPostFX(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  opts: PostFXOptions,
): PostFX | null {
  const wantBloom = (opts.bloom ?? 0) > 0;
  const wantVignette = (opts.vignette ?? 0) > 0;
  if (!wantBloom && !wantVignette) return null;

  const composer = new EffectComposer(renderer);
  composer.setSize(opts.width, opts.height);
  composer.addPass(new RenderPass(scene, camera));

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
  if (wantVignette) {
    const pass = new ShaderPass(VignetteShader);
    pass.uniforms.darkness.value = opts.vignette;
    composer.addPass(pass);
  }
  // OutputPass applies tone mapping (from renderer.toneMapping) + sRGB.
  composer.addPass(new OutputPass());

  return {
    // Pass an explicit delta so the composer never reads its wall-clock timer.
    render: () => composer.render(0),
    setSize: (w, h) => composer.setSize(w, h),
  };
}
