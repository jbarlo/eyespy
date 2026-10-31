/** Each reply as the text a command prints. */
import type { Outputs } from "eyespy-core/api";
import { placeOf } from "eyespy-core/video/pure";
import { hitLine, hitsBlock, objLine, ranges } from "./lines.ts";

type O = Outputs;

export const added = (r: O["add"]): string =>
  `${r.revived ? "re-added (removed earlier; same keyframe numbers)" : "added"} ${r.clip}: keyframes #${r.first}–#${r.first + r.keyframes - 1}` +
  `${r.captured ? `, captured ${r.captured}` : ""}; encoding in background`;

export const clipRemoved = (r: O["clips.remove"]): string => {
  const del = r.deleted.length ? `; deleted objects left empty: ${r.deleted.join(" ")}` : "";
  return (
    `removed ${r.removed} (keyframes #${r.frames[0]}–#${r.frames[1]}, ${r.detections} detections, ${r.stripped} taken out of objects${del})\n` +
    "not undoable; `eyespy add` the same clip to bring its keyframes back (same numbers, no detections)"
  );
};

const mb = (n: number | null) => (n === null ? "?" : `${(n / 2 ** 20).toFixed(0)} MB`);

export const clipsTable = (r: O["clips.list"]): string =>
  r.clips.length
    ? r.clips
        .map((c) =>
          [
            c.key,
            `#${c.frames[0]}–#${c.frames[1]}`.padEnd(9),
            `${c.keyframes} keyframes`.padEnd(13),
            c.removed
              ? "removed".padEnd(36)
              : `${c.detections} dets, ${c.objects} objects, ${mb(c.frame_bytes + c.feature_bytes)}`.padEnd(36),
            c.captured ?? "-",
            c.path,
          ].join("  "),
        )
        .join("\n")
    : "(no clips; eyespy add <frames> [--fps n])";

export const status = (r: O["status"]): string => {
  const clips = r.clips.map((c) => `  ${c.path} (${c.keyframes} keyframes)`);
  return [
    `session ${r.root}`,
    ...(clips.length ? clips : ["  (no clips; eyespy add <frames> [--fps n])"]),
    `encoded ${r.encoded}/${r.keyframes} keyframes, ${r.detections} detections`,
    `objects ${r.objects}, assigned ${r.assigned}, rejected ${r.rejected}, todo ${r.todo}`,
    `prompts: ${r.prompts.join(", ") || "none"}`,
  ].join("\n");
};

export const config = (r: O["config"], key: string | undefined): string => {
  const cfg: Readonly<Record<string, number>> = r.config;
  const def: Readonly<Record<string, number>> = r.defaults;
  const keys = key ? [key] : Object.keys(cfg);
  return keys.map((k) => `${k.padEnd(16)} ${cfg[k]}${cfg[k] !== def[k] ? `  (default ${def[k]})` : ""}`).join("\n");
};

export const sheet = (r: O["sheet"]): string =>
  `${r.frames.map((f) => `#${f.frame}=${placeOf(f)}`).join(" ")}\nimage: ${r.image}`;

export const find = (r: O["find"], prompt: string): string =>
  hitsBlock(
    r,
    `"${prompt}": ${r.hits.length} hits on ${new Set(r.hits.map((h) => h.frame)).size} frames in ${r.seconds}s\n` +
      `present on ${r.present.length}/${Object.keys(r.presence).length} frames: ${ranges(r.present) || "none"}`,
  );

export const search = (r: O["search"]): string =>
  [
    `region ${r.box.join(",")} on #${r.frame} (cropped and upscaled)`,
    ...(r.prompt ? [`"${r.prompt}": ${r.hits.length} hits, presence ${r.presence}`, ...r.hits.map(hitLine)] : []),
    ...(r.similar.length ? ["looks like:", ...r.similar.map((h) => `${hitLine(h)}  sim ${h.sim.toFixed(2)}`)] : []),
  ].join("\n");

export const semantic = (r: O["semantic"]): string => {
  const pres: Readonly<Record<string, number>> = r.presence;
  const area: Readonly<Record<string, number>> = r.area;
  const rows = Object.keys(pres).map(
    (f) =>
      `#${f.padEnd(4)} presence ${(pres[f] ?? 0).toFixed(2)}  active ${((area[f] ?? 0) * 100).toFixed(1)}% of frame`,
  );
  return [...rows, `image: ${r.image}`].join("\n");
};

export const hits = (r: O["dets"] | O["gaps"]): string => hitsBlock(r);
export const crop = (r: O["crop"]): string => hitsBlock(r, hitLine(r));
export const similar = (r: O["similar"]): string => hitsBlock({ hits: r.matches, image: r.image });

export const todo = (r: Extract<O["todo"], { readonly hits: unknown }>): string => {
  const shown = r.hits.length;
  return hitsBlock(r, `${r.total} unassigned${shown < r.total ? ` (showing ${shown})` : ""}`);
};

export const todoGroups = (r: Extract<O["todo"], { readonly groups: unknown }>, offset: number): string =>
  [
    `${r.total} unassigned in ${r.groups_total} groups (showing ${offset}–${offset + r.groups.length - 1})`,
    ...r.groups.map((x) => `${x.group.padEnd(4)} #${x.frames.padEnd(6)} ${x.ids.join(" ")}`),
    `image: ${r.image}`,
  ].join("\n");

export const obj = (r: O["obj.new"]): string => objLine(r);
export const objDeleted = (r: O["obj.delete"]): string => `deleted ${r.deleted}`;

export const objShow = (r: O["obj.show"], offset: number): string =>
  `${objLine(r)}\nshowing ${offset}–${offset + r.hits.length - 1} of ${r.total} (one per alias group)\n${hitsBlock(r)}`;

export const objSuggest = (r: O["obj.suggest"]): string =>
  `${objLine(r.query)}\n${hitsBlock({ hits: r.matches, image: r.image })}`;

export const objMatch = (r: O["obj.match"]): string => {
  const cur = r.current.length ? `currently in ${r.current.join(", ")}\n` : "";
  const rows = r.matches.map(
    (m) =>
      `${m.obj.padEnd(5)} sim ${m.sim.toFixed(2)}  closest ${m.closest} (${m.closest_sim.toFixed(2)})  ${m.sightings} sightings  ${m.label}`,
  );
  return cur + (rows.length ? rows.join("\n") : "(no objects yet)");
};

export const rejected = (r: O["reject"]): string => `rejected ${r.rejected.join(" ")}`;

export const undone = (r: O["undo"]): string => `undid #${r.undone.seq} ${r.undone.op}`;
export const redone = (r: O["redo"]): string => `redid #${r.redone.seq} ${r.redone.op}`;

const when = (ts: number | undefined) => (ts ? new Date(ts * 1000).toISOString().slice(5, 19).replace("T", " ") : "");

/** The last `n` entries (all for 0), then the tops of the undo and redo stacks. */
export const history = (r: O["data.history"], n: number): string =>
  [
    ...r.ops.slice(-n).map(({ seq, op, ts, undone, undoable: _u, objects: _o, ...rest }) => {
      return `#${String(seq).padEnd(4)} ${when(ts)}  ${op.padEnd(7)} ${JSON.stringify(rest)}${undone ? "  (undone)" : ""}`;
    }),
    `undo: ${r.undo ? `#${r.undo.seq} ${r.undo.op}` : "-"}   redo: ${r.redo ? `#${r.redo.seq} ${r.redo.op}` : "-"}`,
  ].join("\n");

export const manifest = (r: O["manifest"]): string =>
  r.items.length
    ? [
        ...r.items.map((i) => `${String(i.count).padStart(3)}  ${i.label}`),
        "",
        ...r.objects.map(objLine),
        ...(r.image ? [`image: ${r.image}`] : []),
      ].join("\n")
    : "(no objects yet)";

export const exported = (r: O["manifest"], file: string): string => `wrote ${r.objects.length} objects to ${file}`;
