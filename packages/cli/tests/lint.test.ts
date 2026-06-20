import { describe, expect, test } from "bun:test";
import { lintHtml } from "../src/lint";

const allFiles = () => true;
const noFiles = () => false;

function rules(html: string, fileExists = allFiles): string[] {
  return lintHtml(html, { fileExists }).map((f) => f.rule);
}

const RUNTIME = `<script type="module">import "./assets/stereoframe.js";</script>`;
const OK = `
  <sf-scene duration="5">
    <sf-camera position="0 1 5"></sf-camera>
    <sf-mesh id="hero" geometry="box"></sf-mesh>
    <sf-light preset="studio"></sf-light>
    <sf-animate target="#hero" verb="turntable" rpm="6"></sf-animate>
  </sf-scene>
  ${RUNTIME}
`;

describe("lint", () => {
  test("clean composition has no findings", () => {
    expect(rules(OK)).toEqual([]);
  });

  test("missing_scene + missing_runtime_import on empty page", () => {
    const r = rules(`<div></div>`);
    expect(r).toContain("missing_scene");
    expect(r).toContain("missing_runtime_import");
  });

  test("missing_duration", () => {
    expect(rules(`<sf-scene></sf-scene>${RUNTIME}`)).toContain("missing_duration");
  });

  test("ignores sf-* tags inside HTML comments (no false positives)", () => {
    // A doc comment mentioning <sf-scene> must not register as a real element.
    const html = `<!-- place DOM before <sf-scene> so the canvas occludes it -->\n${OK}`;
    expect(rules(html)).toEqual([]);
  });

  test("asset_not_found and remote_asset", () => {
    const html = `
      <sf-scene duration="5">
        <sf-model src="assets/missing.glb"></sf-model>
        <sf-ocean normals="https://cdn.example.com/n.jpg"></sf-ocean>
      </sf-scene>${RUNTIME}`;
    const r = rules(html, noFiles);
    expect(r).toContain("asset_not_found");
    expect(r).toContain("remote_asset");
  });

  test("sf-group is a recognized element + grouped/animated content is clean", () => {
    const html = `
      <sf-scene duration="4">
        <sf-camera look-at="#rig"></sf-camera>
        <sf-group id="rig" position="0 0.5 0">
          <sf-mesh id="a" geometry="box" position="-1.5 0 0"></sf-mesh>
          <sf-mesh id="b" geometry="sphere" position="1.5 0 0"></sf-mesh>
        </sf-group>
        <sf-animate target="#rig" verb="turntable" rpm="20"></sf-animate>
        <sf-animate target="#a" verb="turntable" rpm="60" axis="x"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toEqual([]);
  });

  test("ir_dangling_ref flags an orbit around a missing #id; valid ref is clean", () => {
    const bad = `
      <sf-scene duration="6">
        <sf-mesh id="hero" geometry="box"></sf-mesh>
        <sf-animate target="camera" verb="orbit" around="#heor" duration="6"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(bad)).toContain("ir_dangling_ref");
    const good = bad.replace("#heor", "#hero");
    expect(rules(good)).not.toContain("ir_dangling_ref");
  });

  test("ir_zero_duration flags a windowed verb with non-positive duration", () => {
    const html = `
      <sf-scene duration="6">
        <sf-mesh id="hero" geometry="box"></sf-mesh>
        <sf-animate target="#hero" verb="move" to="1 0 0" duration="0"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toContain("ir_zero_duration");
  });

  test("ir_unreachable flags a verb starting at/after the scene duration", () => {
    const html = `
      <sf-scene duration="5">
        <sf-mesh id="hero" geometry="box"></sf-mesh>
        <sf-animate target="#hero" verb="move" to="1 0 0" start="6" duration="1"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toContain("ir_unreachable");
  });

  test("ir_channel_conflict flags two same-start drivers on one channel", () => {
    const html = `
      <sf-scene duration="6">
        <sf-mesh id="hero" geometry="box"></sf-mesh>
        <sf-animate target="camera" verb="orbit" around="#hero" start="0" duration="6"></sf-animate>
        <sf-animate target="camera" verb="dolly" toward="#hero" start="0" duration="2"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toContain("ir_channel_conflict");
  });

  test("sequential drivers on one channel (different starts) are NOT a conflict", () => {
    const html = `
      <sf-scene duration="6">
        <sf-mesh id="hero" geometry="box"></sf-mesh>
        <sf-animate target="camera" verb="dolly" toward="#hero" start="0" duration="2"></sf-animate>
        <sf-animate target="camera" verb="orbit" around="#hero" start="2" duration="4"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).not.toContain("ir_channel_conflict");
  });

  test("time_impurity catches wall-clock and RNG in inline scripts", () => {
    const html = `${OK}<script type="stereoframe">sf.onSeek(() => Math.random());</script>`;
    expect(rules(html)).toContain("time_impurity");
  });

  test("unknown_element / unknown_verb / unknown_ease", () => {
    const html = `
      <sf-scene duration="5">
        <sf-modle src="a.glb"></sf-modle>
        <sf-mesh id="x"></sf-mesh>
        <sf-animate target="#x" verb="wiggle"></sf-animate>
        <sf-animate target="#x" verb="fade-in" ease="zoomy.out"></sf-animate>
      </sf-scene>${RUNTIME}`;
    const r = rules(html);
    expect(r).toContain("unknown_element");
    expect(r).toContain("unknown_verb");
    expect(r).toContain("unknown_ease");
  });

  test("verb_target_missing", () => {
    const html = `
      <sf-scene duration="5">
        <sf-animate target="#ghost" verb="turntable"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toContain("verb_target_missing");
  });

  test("camera_path_lookat_conflict", () => {
    const html = `
      <sf-scene duration="5">
        <sf-camera look-at="0 0 0"></sf-camera>
        <sf-animate target="camera" verb="camera-path" points="0 0 0, 1 1 1"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).toContain("camera_path_lookat_conflict");
  });

  test("camera-path with look=none does not conflict", () => {
    const html = `
      <sf-scene duration="5">
        <sf-camera look-at="0 0 0"></sf-camera>
        <sf-animate target="camera" verb="camera-path" look="none" points="0 0 0, 1 1 1"></sf-animate>
      </sf-scene>${RUNTIME}`;
    expect(rules(html)).not.toContain("camera_path_lookat_conflict");
  });

  test("dom_clip_missing_class", () => {
    const html = `${OK}<div id="title" data-start="1">hi</div>`;
    expect(rules(html)).toContain("dom_clip_missing_class");
    const ok = `${OK}<div id="title" class="clip" data-start="1">hi</div>`;
    expect(rules(ok)).not.toContain("dom_clip_missing_class");
  });

  test("transition_gap when previous shot ends before the fade completes", () => {
    const html = `
      <sf-scene start="0" duration="5"></sf-scene>
      <sf-scene start="5" duration="5" transition="crossfade" transition-duration="0.8"></sf-scene>
      ${RUNTIME}`;
    expect(rules(html)).toContain("transition_gap");
    const ok = `
      <sf-scene start="0" duration="5.8"></sf-scene>
      <sf-scene start="5" duration="5" transition="crossfade" transition-duration="0.8"></sf-scene>
      ${RUNTIME}`;
    expect(rules(ok)).not.toContain("transition_gap");
  });
});
