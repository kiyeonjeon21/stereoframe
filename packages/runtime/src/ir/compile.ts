/**
 * compile(SceneIR) → CompiledIR.
 *
 * Pure, three.js-free, DOM-free. Walks the timeline tree once, resolving the
 * `seq`/`par`/`stagger`/`beat` algebra into flat per-channel segments with
 * absolute times, inferring total duration bottom-up, and recording
 * `labelTimes`/`beatTimes`. Each segment is registered under every channel its
 * driver writes, so `evaluate` can hold the active segment per channel.
 */
import { driverChannels, type CompiledIR, type SceneIR, type Segment, type Span, type TimelineIR } from "./types";

const DEFAULT_EASE = "power1.out";

interface Acc {
  byChannel: Map<string, Segment[]>;
  labels: Map<string, Span>;
  beats: Map<string, Span>;
}

function addSegment(acc: Acc, seg: Segment): void {
  for (const ch of driverChannels(seg.driver)) {
    const key = `${seg.driver.target}.${ch}`;
    const list = acc.byChannel.get(key);
    if (list) list.push(seg);
    else acc.byChannel.set(key, [seg]);
  }
}

/** Place a timeline node at absolute `t0`, durations scaled by `scale` (beat
 *  stretch). Emits into `acc`. Returns the node's end time. */
function place(node: TimelineIR, t0: number, scale: number, acc: Acc): number {
  switch (node.kind) {
    case "clip": {
      const duration = node.duration * scale;
      addSegment(acc, { driver: node.driver, start: t0, duration, ease: node.ease ?? DEFAULT_EASE, label: node.label });
      if (node.label) acc.labels.set(node.label, { t0, t1: t0 + duration });
      return t0 + duration;
    }
    case "wait": {
      const end = t0 + node.duration * scale;
      if (node.label) acc.labels.set(node.label, { t0, t1: end });
      return end;
    }
    case "seq": {
      let cur = t0;
      for (const child of node.children) cur = place(child, cur, scale, acc);
      return cur;
    }
    case "par": {
      let end = t0;
      for (const child of node.children) end = Math.max(end, place(child, t0, scale, acc));
      return end;
    }
    case "stagger": {
      let end = t0;
      node.children.forEach((child, i) => {
        end = Math.max(end, place(child, t0 + i * node.interval * scale, scale, acc));
      });
      return end;
    }
    case "beat": {
      const start = node.at != null ? node.at : t0 + (node.gap ?? 0) * scale;
      const innerScale = scale * (node.scale ?? 1);
      let cur = start;
      for (const child of node.children) cur = place(child, cur, innerScale, acc);
      acc.beats.set(node.name, { t0: start, t1: cur });
      return cur;
    }
  }
}

export function compile(scene: SceneIR): CompiledIR {
  const acc: Acc = { byChannel: new Map(), labels: new Map(), beats: new Map() };
  const timelineEnd = scene.timeline ? place(scene.timeline, 0, 1, acc) : 0;

  for (const list of acc.byChannel.values()) list.sort((a, b) => a.start - b.start);

  return {
    nodes: new Map(scene.nodes.map((n) => [n.id, n])),
    segments: acc.byChannel,
    behaviors: scene.behaviors,
    duration: Math.max(scene.duration ?? 0, timelineEnd),
    labelTimes: acc.labels,
    beatTimes: acc.beats,
  };
}
