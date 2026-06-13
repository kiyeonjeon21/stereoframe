import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageToDataUri, resolveEnvKey } from "../src/gen";
import { getImageProvider, isolationPrompt, openaiImageProvider } from "../src/imagegen";

const tmp = mkdtempSync(join(tmpdir(), "sf-gen-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("imageToDataUri", () => {
  test("encodes a png into a base64 data URI", () => {
    const p = join(tmp, "shot.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uri = imageToDataUri(p);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri.endsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"))).toBe(true);
  });
  test("maps jpg/jpeg to image/jpeg", () => {
    const p = join(tmp, "shot.jpeg");
    writeFileSync(p, Buffer.from([1, 2, 3]));
    expect(imageToDataUri(p).startsWith("data:image/jpeg;base64,")).toBe(true);
  });
  test("rejects unsupported extensions", () => {
    const p = join(tmp, "shot.gif");
    writeFileSync(p, Buffer.from([1]));
    expect(() => imageToDataUri(p)).toThrow(/unsupported image/);
  });
  test("throws on a missing file", () => {
    expect(() => imageToDataUri(join(tmp, "nope.png"))).toThrow(/not found/);
  });
});

describe("resolveEnvKey", () => {
  test("explicit value wins", () => {
    expect(resolveEnvKey("SF_TEST_KEY_XYZ", tmp, "explicit-123")).toBe("explicit-123");
  });
  test("reads from a .env walking up from a subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-env-"));
    writeFileSync(join(root, ".env"), "FOO=bar\nSF_TEST_KEY_XYZ=from-dotenv\n");
    const sub = join(root, "a", "b");
    require("node:fs").mkdirSync(sub, { recursive: true });
    expect(resolveEnvKey("SF_TEST_KEY_XYZ", sub)).toBe("from-dotenv");
    rmSync(root, { recursive: true, force: true });
  });
  test("returns undefined when unset", () => {
    expect(resolveEnvKey("SF_DEFINITELY_UNSET_KEY_999", tmp)).toBeUndefined();
  });
});

describe("imagegen", () => {
  test("isolationPrompt appends the clean-shot guidance", () => {
    const p = isolationPrompt("a red sneaker");
    expect(p).toMatch(/a red sneaker/);
    expect(p).toMatch(/isolated/i);
    expect(p).toMatch(/background/i);
  });
  test("getImageProvider returns openai by default; rejects unknown", () => {
    expect(getImageProvider().name).toBe("openai");
    expect(getImageProvider("openai")).toBe(openaiImageProvider);
    expect(() => getImageProvider("midjourney")).toThrow(/unknown image provider/);
  });
});
