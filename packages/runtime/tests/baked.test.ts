import { describe, expect, test } from "bun:test";
import { bakedFrameIndex } from "../src/blocks/baked";

describe("bakedFrameIndex (step sampling)", () => {
  test("rounds t*fps to the nearest frame", () => {
    expect(bakedFrameIndex(0, 30, 100)).toBe(0);
    expect(bakedFrameIndex(1, 30, 100)).toBe(30);
    expect(bakedFrameIndex(1 / 60, 30, 100)).toBe(1); // 0.5 → 1 (round half up)
  });

  test("clamps to [0, frames-1]", () => {
    expect(bakedFrameIndex(-5, 30, 100)).toBe(0);
    expect(bakedFrameIndex(999, 30, 100)).toBe(99);
  });
});

describe("bake .bin layout (frame-major mat4) round-trips through a Buffer", () => {
  test("Float32Array → Buffer → Float32Array preserves frame/instance offsets", () => {
    const frames = 3;
    const count = 2;
    const stride = 16;
    const src = new Float32Array(frames * count * stride);
    // tag each (frame, instance) so we can verify offset math
    for (let f = 0; f < frames; f++)
      for (let i = 0; i < count; i++) src[(f * count + i) * stride] = f * 100 + i;

    // exactly how bake.ts writes / baked.ts reads
    const bytes = Buffer.from(src.buffer, 0, src.byteLength);
    const back = new Float32Array(bytes.buffer, bytes.byteOffset, frames * count * stride);

    expect(back[(2 * count + 1) * stride]).toBe(201); // frame 2, instance 1
    expect(back[(0 * count + 0) * stride]).toBe(0);
    expect(back.length).toBe(src.length);
  });
});
