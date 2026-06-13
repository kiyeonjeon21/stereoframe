/**
 * `stereoframe add <block>` — installs a visual block: copies any required
 * assets into the project's assets/ directory and prints a markup snippet.
 * Blocks themselves live in the runtime (<sf-ocean>, <sf-sky>, …); this
 * command only delivers their assets and usage.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BlockDef {
  description: string;
  assets: string[];
  snippet: string;
}

const BLOCKS: Record<string, BlockDef> = {
  ocean: {
    description: "animated water plane (three.js Water) — reflections, sun glint",
    assets: ["waternormals.jpg"],
    snippet: `  <sf-ocean size="2000" color="#001e0f" speed="1"></sf-ocean>
  <!-- pair with <sf-sky> (its sun drives the water highlights) and
       <sf-camera far="5000"> so the horizon isn't clipped -->`,
  },
  sky: {
    description: "physical atmosphere dome (three.js Sky) — sun by elevation/azimuth",
    assets: [],
    snippet: `  <sf-sky elevation="12" azimuth="200" turbidity="8"></sf-sky>
  <!-- low elevation (2-15) = golden hour; set <sf-scene exposure="0.6"> for balance -->`,
  },
};

function packagedAssetPath(file: string): string {
  // dist/cli.js → ../assets/<file>
  return fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
}

export function listBlocks(): string {
  return Object.entries(BLOCKS)
    .map(([name, def]) => `  ${name.padEnd(8)} ${def.description}`)
    .join("\n");
}

export function addBlock(name: string, projectDir: string): string {
  const block = BLOCKS[name];
  if (!block) {
    throw new Error(`unknown block: ${name}\n\navailable blocks:\n${listBlocks()}`);
  }
  const assetsDir = join(resolve(projectDir), "assets");
  mkdirSync(assetsDir, { recursive: true });
  const copied: string[] = [];
  for (const asset of block.assets) {
    const src = packagedAssetPath(asset);
    if (!existsSync(src)) throw new Error(`packaged asset missing: ${src}`);
    copyFileSync(src, join(assetsDir, asset));
    copied.push(`assets/${asset}`);
  }
  const lines = [
    copied.length > 0 ? `installed: ${copied.join(", ")}` : "no assets needed",
    "",
    "add inside <sf-scene>:",
    block.snippet,
  ];
  return lines.join("\n");
}
