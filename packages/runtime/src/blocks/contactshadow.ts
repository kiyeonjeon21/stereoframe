/**
 * Contact shadow — the soft ground shadow that stops a product from looking
 * like floating CG. Renders the scene from a top-down orthographic camera
 * with a depth material into a render target, blurs it (H+V passes), and
 * maps it onto a ground plane under the model. Fully deterministic: it's a
 * pure render of the current (t-posed) scene, re-run each frame via update().
 *
 * Adapted from three.js' webgl_shadow_contact example.
 */
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  WebGLRenderTarget,
  type Scene,
  type WebGLRenderer,
} from "three";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";

export interface ContactShadowOptions {
  size?: number;
  y?: number;
  height?: number;
  opacity?: number;
  blur?: number;
  darkness?: number;
  resolution?: number;
}

export interface ContactShadow {
  group: Group;
  update: () => void;
}

export function buildContactShadow(
  renderer: WebGLRenderer,
  scene: Scene,
  opts: ContactShadowOptions = {},
): ContactShadow {
  const size = opts.size ?? 5;
  const y = opts.y ?? 0;
  const height = opts.height ?? size * 0.6;
  const opacity = opts.opacity ?? 0.75;
  const blur = opts.blur ?? 3;
  const darkness = opts.darkness ?? 1.4;
  const resolution = opts.resolution ?? 512;

  const group = new Group();
  group.position.y = y;

  const renderTarget = new WebGLRenderTarget(resolution, resolution);
  renderTarget.texture.generateMipmaps = false;
  const renderTargetBlur = new WebGLRenderTarget(resolution, resolution);
  renderTargetBlur.texture.generateMipmaps = false;

  const planeGeometry = new PlaneGeometry(size, size).rotateX(Math.PI / 2);

  const plane = new Mesh(
    planeGeometry,
    new MeshBasicMaterial({ map: renderTarget.texture, opacity, transparent: true, depthWrite: false }),
  );
  plane.renderOrder = 1;
  plane.scale.y = -1; // the depth render is upside-down
  group.add(plane);

  const blurPlane = new Mesh(planeGeometry);
  blurPlane.visible = false;
  group.add(blurPlane);

  // Looks straight up from the ground, capturing the silhouette of whatever
  // is above it within `height`.
  const shadowCamera = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
  shadowCamera.rotation.x = Math.PI / 2;
  group.add(shadowCamera);

  const depthMaterial = new MeshDepthMaterial();
  const darknessU = { value: darkness };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = darknessU;
    shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader}`.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );",
    );
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const hBlur = new ShaderMaterial(HorizontalBlurShader);
  hBlur.depthTest = false;
  const vBlur = new ShaderMaterial(VerticalBlurShader);
  vBlur.depthTest = false;

  function blurShadow(amount: number): void {
    blurPlane.visible = true;
    blurPlane.material = hBlur;
    (hBlur.uniforms.tDiffuse.value as unknown) = renderTarget.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(renderTargetBlur);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.material = vBlur;
    (vBlur.uniforms.tDiffuse.value as unknown) = renderTargetBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(renderTarget);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.visible = false;
  }

  const update = (): void => {
    const initialBg = scene.background;
    const initialEnv = scene.environment;
    const autoClear = renderer.autoClear;
    scene.background = null;
    scene.environment = null; // env-lit materials would pollute the depth pass
    renderer.autoClear = false;
    plane.visible = false;
    scene.overrideMaterial = depthMaterial;

    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(scene, shadowCamera);

    scene.overrideMaterial = null;
    blurShadow(blur);
    blurShadow(blur * 0.4);

    renderer.setRenderTarget(null);
    renderer.autoClear = autoClear;
    plane.visible = true;
    scene.background = initialBg;
    scene.environment = initialEnv;
  };

  return { group, update };
}
