#!/usr/bin/env bun
import { execFileSync } from "node:child_process";

const currentTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!currentTag) {
  console.error("usage: bun scripts/release-notes.mjs <tag>");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function previousTag() {
  const tags = git(["tag", "--sort=-version:refname"])
    .split("\n")
    .filter(Boolean)
    .filter((tag) => tag !== currentTag);
  return tags[0] ?? "";
}

function commits(fromTag) {
  const range = fromTag ? `${fromTag}..${currentTag}` : currentTag;
  const out = git(["log", "--reverse", "--pretty=format:%h%x00%s", range]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash, subject };
    })
    .filter((commit) => !/^release:\s+v\d+\.\d+\.\d+$/i.test(commit.subject));
}

const groups = [
  { title: "Highlights", types: ["feat"] },
  { title: "Fixes", types: ["fix"] },
  { title: "Performance", types: ["perf"] },
  { title: "Documentation", types: ["docs"] },
  { title: "CI", types: ["ci"] },
  { title: "Tests", types: ["test"] },
  { title: "Maintenance", types: ["chore", "build", "refactor", "style"] },
  { title: "Other", types: [] },
];

function parseSubject(subject) {
  const match = subject.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s+(.+)$/i);
  if (!match) return { type: "other", scope: "", text: subject };
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ?? "",
    text: match[3],
  };
}

function sentenceCase(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function polishText(text) {
  return text
    .replace(/\b3d\b/gi, "3D")
    .replace(/\bglb\b/gi, "GLB")
    .replace(/\bgltf\b/gi, "GLTF")
    .replace(/\bcli\b/gi, "CLI")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bcodex\b/gi, "Codex");
}

function formatCommit(commit) {
  const parsed = parseSubject(commit.subject);
  const scope = parsed.scope ? `${parsed.scope}: ` : "";
  return `- ${scope}${polishText(sentenceCase(parsed.text))} (${commit.hash})`;
}

const prevTag = previousTag();
const byGroup = new Map(groups.map((group) => [group.title, []]));

for (const commit of commits(prevTag)) {
  const parsed = parseSubject(commit.subject);
  const group = groups.find((candidate) => candidate.types.includes(parsed.type)) ?? groups.at(-1);
  byGroup.get(group.title).push(formatCommit(commit));
}

const lines = ["## Changes", ""];
for (const group of groups) {
  const items = byGroup.get(group.title);
  if (!items.length) continue;
  lines.push(`### ${group.title}`, "", ...items, "");
}

if (!lines.some((line) => line.startsWith("### "))) {
  lines.push("- No user-facing changes recorded.", "");
}

if (repo && prevTag) {
  lines.push(`**Full Changelog**: https://github.com/${repo}/compare/${prevTag}...${currentTag}`, "");
}

console.log(lines.join("\n"));
