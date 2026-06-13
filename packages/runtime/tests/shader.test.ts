import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildShader } from "../src/blocks/shader";

/** Minimal stand-in for the DOM Element buildShader reads — it only touches
 *  attributes / getAttribute / textContent / querySelector. (No DOM harness in
 *  the runtime test env; ShaderMaterial just stores strings, so no GL needed.) */
function stubEl(opts: {
  attrs?: Record<string, string>;
  text?: string;
  vert?: string;
  frag?: string;
}): Element {
  const attrs = opts.attrs ?? {};
  const children: Record<string, { textContent: string }> = {};
  if (opts.vert !== undefined) children["sf-vert"] = { textContent: opts.vert };
  if (opts.frag !== undefined) children["sf-frag"] = { textContent: opts.frag };
  return {
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (n: string) => (n in attrs ? attrs[n]! : null),
    textContent: opts.text ?? "",
    querySelector: (sel: string) => children[sel] ?? null,
  } as unknown as Element;
}

const opts = (fullscreen = false) => ({
  width: 1920,
  height: 1080,
  geometry: new THREE.PlaneGeometry(1, 1),
  fullscreen,
});

const matOf = (b: { mesh: THREE.Mesh }) => b.mesh.material as THREE.ShaderMaterial;

describe("buildShader — vertex hook", () => {
  test("an <sf-vert> child builds a templated vertex shader with the snippet in scope", () => {
    const snippet = "transformed += normal * fbm(uv * 4.0 + uTime) * uAmp;";
    const build = buildShader(
      stubEl({
        attrs: { "u-amp": "0.3" },
        vert: snippet,
        frag: "void main(){ gl_FragColor = vec4(vUv, 0.6, 1.0); }",
      }),
      opts(),
    );
    const mat = matOf(build);
    // Author snippet + the displacement scaffold are present.
    expect(mat.vertexShader).toContain(snippet);
    expect(mat.vertexShader).toContain("vec3 transformed = position;");
    expect(mat.vertexShader).toContain("gl_Position = projectionMatrix * modelViewMatrix");
    // uTime + the sin-free toolkit are in scope in the vertex stage.
    expect(mat.vertexShader).toContain("uniform float uTime;");
    expect(mat.vertexShader).toContain("float fbm(vec2 p)");
    // The u-* uniform reaches both the GLSL decls and the uniforms map.
    expect(mat.vertexShader).toContain("uniform float uAmp;");
    expect(mat.uniforms.uAmp!.value).toBe(0.3);
    // Fragment comes from <sf-frag>.
    expect(mat.fragmentShader).toContain("gl_FragColor = vec4(vUv, 0.6, 1.0);");
  });

  test("missing <sf-frag> alongside <sf-vert> falls back to the default frag, not the vert text", () => {
    const build = buildShader(stubEl({ vert: "transformed.y += uTime;" }), opts());
    const mat = matOf(build);
    expect(mat.vertexShader).toContain("transformed.y += uTime;");
    // The default frag is used; the vert snippet must NOT leak into the fragment.
    expect(mat.fragmentShader).not.toContain("transformed.y += uTime;");
    expect(mat.fragmentShader).toContain("gl_FragColor");
  });
});

describe("buildShader — back-compat (fragment-only, unchanged)", () => {
  test("no <sf-vert>: fragment is the element text and the vertex shader is the default", () => {
    const frag = "void main(){ gl_FragColor = vec4(1.0); }";
    const mat = matOf(buildShader(stubEl({ text: frag }), opts()));
    expect(mat.fragmentShader).toContain(frag);
    // Default mesh vertex shader — no displacement scaffold.
    expect(mat.vertexShader).toContain("vec4(position, 1.0)");
    expect(mat.vertexShader).not.toContain("transformed");
  });

  test("fullscreen ignores a vertex block (clip-space quad has no displacement)", () => {
    const mat = matOf(
      buildShader(stubEl({ vert: "transformed += 1.0;", frag: "void main(){}" }), opts(true)),
    );
    expect(mat.vertexShader).toContain("vec4(position.xy, 0.0, 1.0)");
    expect(mat.vertexShader).not.toContain("transformed");
  });
});
