#!/usr/bin/env bun
/**
 * Fuzz the GLB pipeline against real, varied models.
 *
 * Pulls the Khronos glTF-Sample-Assets catalogue (118 models with a .glb), then
 * for each picked model runs the whole pipeline — inspect → stage --preset spec
 * → validate — and reports only what broke (errors, black frames, single-mesh,
 * crashes). The point is COVERAGE: different scales, rigs, materials, node
 * trees, compression — the structural variety `stage`/`inspect`/`teardown` must
 * survive. (Use scripts/fetch-fixtures.sh-style fixed sets for regression CI;
 * this is the discovery tool.)
 *
 *   bun scripts/fuzz-models.mjs                 # 10 random models
 *   bun scripts/fuzz-models.mjs 6               # 6 random models
 *   bun scripts/fuzz-models.mjs 5 helmet car    # 5 models matching the prompt
 *   bun scripts/fuzz-models.mjs car --keep      # keep the downloads/renders
 *
 * A user's arbitrary prompt is matched against model names/labels; if nothing
 * matches it falls back to random (for true open-vocabulary prompts, that's
 * what `stereoframe gen` + Meshy is for — this only fetches from the catalogue).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "cli", "dist", "cli.js");
const INDEX_URL =
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/model-index.json";
const RAW_BASE = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models";

// --- args: [N] [prompt words...] [--keep] [--gen] --------------------------
// Default: pull N models from the Khronos catalogue (prompt matches names).
// --gen: instead GENERATE N models from text via Meshy (real key in .env; slow),
// then run the same inspect→stage→validate pipeline — surfaces how generated
// (single-mesh, junk-named) models fare. Bigger N is expensive; default 3.
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const genMode = argv.includes("--gen");
const rest = argv.filter((a) => a !== "--keep" && a !== "--gen");
let n = genMode ? 3 : 10;
const promptWords = [];
for (const a of rest) {
  if (/^\d+$/.test(a) && promptWords.length === 0) n = Number(a);
  else promptWords.push(a);
}
const prompt = promptWords.join(" ").toLowerCase().trim();

// Curated diverse prompts for --gen (product-y, varied subjects).
const GEN_PROMPTS = [
  "a vintage brass desk lamp",
  "a pair of over-ear headphones, matte black",
  "a modern espresso machine, stainless steel",
  "a retro handheld game console",
  "a ceramic teapot with a bamboo handle",
  "a robot vacuum, white and grey",
  "a mechanical wristwatch with a metal bracelet",
  "a perfume bottle, frosted glass",
];
const slug = (p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "gen";

function run(args, opts = {}) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", timeout: 180_000, ...opts });
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), err: r.error };
}

async function main() {
  // `picked`: uniform items — {name, url} (catalogue) or {name, prompt} (--gen).
  let picked;
  if (genMode) {
    const list = (prompt ? [prompt] : GEN_PROMPTS).slice(0, n);
    picked = list.map((p) => ({ name: slug(p), prompt: p }));
    console.log(`generating ${picked.length} model(s) via Meshy (real key, ~minutes each):\n  ${list.join("\n  ")}\n`);
  } else {
    console.log("fetching Khronos sample catalogue…");
    const index = await (await fetch(INDEX_URL)).json();
    const usable = index.filter((m) => m.variants && m.variants["glTF-Binary"]);
    let pool = usable;
    if (prompt) {
      const tokens = prompt.split(/\s+/);
      const scored = usable
        .map((m) => {
          const hay = `${m.name} ${m.label ?? ""}`.toLowerCase();
          const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
          return { m, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        pool = scored.map((x) => x.m);
        console.log(`prompt "${prompt}" matched ${pool.length}: ${pool.slice(0, 12).map((m) => m.name).join(", ")}`);
      } else {
        console.log(`prompt "${prompt}" matched nothing in the catalogue — falling back to random.`);
      }
    }
    picked = [...pool]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(n, pool.length))
      .map((m) => ({ name: m.name, url: `${RAW_BASE}/${m.name}/glTF-Binary/${m.variants["glTF-Binary"]}` }));
    console.log(`testing ${picked.length} model(s): ${picked.map((m) => m.name).join(", ")}\n`);
  }

  const work = mkdtempSync(join(tmpdir(), "sf-fuzz-"));
  mkdirSync(join(work, "models"));
  const results = [];

  for (const it of picked) {
    const glb = join(work, "models", `${it.name}.glb`);
    const row = { name: it.name, parts: "", flags: "", stage: "", validate: "", status: "ok" };
    process.stdout.write(`• ${it.name}  `);
    try {
      if (it.prompt) {
        // generate via Meshy (cwd=ROOT so it picks up the .env key)
        const g = run(["gen", it.prompt, "--out", glb], { cwd: ROOT, timeout: 600_000 });
        if (g.status !== 0 || !existsSync(glb)) throw new Error("gen failed");
      } else {
        const res = await fetch(it.url);
        if (!res.ok) throw new Error(`download ${res.status}`);
        writeFileSync(glb, Buffer.from(await res.arrayBuffer()));
      }
    } catch (e) {
      row.status = it.prompt ? "GEN-FAIL" : "DOWNLOAD-FAIL";
      row.flags = String(e.message ?? e);
      results.push(row);
      console.log("✗");
      continue;
    }

    // 1. inspect
    const ins = run(["inspect", glb, "--json"]);
    if (ins.status !== 0) {
      row.status = "INSPECT-CRASH";
      row.flags = ins.out.split("\n").find((l) => /error|Error/.test(l))?.slice(0, 80) ?? "";
      results.push(row);
      console.log("✗ inspect");
      continue;
    }
    try {
      const man = JSON.parse(ins.out.slice(ins.out.indexOf("{")));
      row.parts = `${man.meshParts}mesh/${man.partCount}`;
      row.flags = [man.isSingleMesh ? "single-mesh" : "", man.hasRig ? "rigged" : ""].filter(Boolean).join(",");
    } catch {
      row.parts = "?";
    }

    // 2. stage --preset spec
    const stageDir = join(work, `stage-${it.name}`);
    const st = run(["stage", glb, "--preset", "spec", "--dir", stageDir, "--duration", "5"]);
    if (st.status !== 0) {
      row.status = "STAGE-CRASH";
      row.stage = st.out.split("\n").find((l) => /error|Error/.test(l))?.slice(0, 70) ?? "";
      results.push(row);
      console.log("✗ stage");
      continue;
    }
    row.stage = /callouts:/.test(st.out) ? st.out.match(/callouts: (.+)/)?.[1]?.slice(0, 50) ?? "ok" : "none";

    // 3. validate the staged film (headless probes: black frame, framing, seek)
    const va = run(["validate", stageDir]);
    const mm = va.out.match(/(\d+) error\(s\), (\d+) warning\(s\)/);
    const errs = mm ? Number(mm[1]) : -1;
    const warns = mm ? Number(mm[2]) : -1;
    row.validate = `${errs}e/${warns}w`;
    if (errs > 0 || va.status !== 0) row.status = "VALIDATE-ERR";
    else if (warns > 0) row.status = "warn";
    results.push(row);
    console.log(row.status === "ok" ? "✓" : row.status === "warn" ? "⚠" : "✗");
  }

  // --- report --------------------------------------------------------------
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`\n${"─".repeat(96)}`);
  console.log(`${pad("model", 22)}${pad("parts", 12)}${pad("flags", 18)}${pad("callouts", 22)}${pad("valid", 8)}status`);
  console.log("─".repeat(96));
  for (const r of results) {
    console.log(`${pad(r.name, 22)}${pad(r.parts, 12)}${pad(r.flags, 18)}${pad(r.stage, 22)}${pad(r.validate, 8)}${r.status}`);
  }
  const bad = results.filter((r) => !["ok", "warn"].includes(r.status));
  const warned = results.filter((r) => r.status === "warn");
  console.log("─".repeat(96));
  console.log(`\n${results.length} tested · ${results.filter((r) => r.status === "ok").length} clean · ${warned.length} warn · ${bad.length} fail`);
  if (bad.length) console.log(`failures: ${bad.map((r) => `${r.name}(${r.status})`).join(", ")}`);

  if (keep) console.log(`\nkept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
