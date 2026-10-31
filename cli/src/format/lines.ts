/** The building blocks every reply's text uses: a detection row, an object row, a hits block, frame ranges. */
import type { Outputs } from "eyespy-core/api";

export type Hit = Outputs["dets"]["hits"][number];
export type Obj = Outputs["obj.new"];

/** A keyframe's place as the drawn frame tag gives it: "photo <position>" for a photo, else "<t>s". */
const when = (f: { readonly t: number; readonly photo?: true }): string =>
  f.photo ? `photo ${f.t}` : `${f.t.toFixed(1)}s`;

/** `id  t  score  [box]  sim=  prompts  → object`, empty columns dropped. */
export const hitLine = (h: Hit & { readonly sim?: number }): string =>
  [
    h.id.padEnd(6),
    when(h).padStart(6),
    h.score.toFixed(2),
    `[${h.box.join(",")}]`.padEnd(22),
    h.sim !== undefined ? `sim=${h.sim.toFixed(2)}` : "",
    h.prompts.join(", "),
    h.object ? `→ ${h.object}` : "",
  ]
    .filter(Boolean)
    .join("  ");

/** A time with one decimal; a missing one prints as `undefined`. */
const time = (t: number | null): string => (t === null ? "undefined" : t.toFixed(1));

/** `o1    label  (n sightings, a–bs, best id)  [prompt score, ...]` */
export const objLine = (o: Obj): string =>
  `${o.id.padEnd(4)}  ${o.label}  (${o.sightings} sightings, ${time(o.first_t)}–${time(o.last_t)}s, best ${o.best})` +
  `  [${Object.entries(o.prompts)
    .map(([p, v]) => `${p} ${v.toFixed(2)}`)
    .join(", ")}]`;

/**
 * Every query prints its hits and the rendered image path, so an agent can look at the result. It prints the optional
 * head, then the hits (or "(no detections)") when the reply has a list, then `image: <path>` when there is one.
 */
export const hitsBlock = (
  r: { readonly hits?: readonly (Hit & { readonly sim?: number })[]; readonly image?: string | null },
  head?: string,
): string =>
  [
    ...(head ? [head] : []),
    ...(r.hits ? [r.hits.length ? r.hits.map(hitLine).join("\n") : "(no detections)"] : []),
    ...(r.image ? [`image: ${r.image}`] : []),
  ].join("\n");

/** Turns [1,2,3,7,9,10] into "1-3,7,9-10". */
export const ranges = (xs: readonly number[]): string =>
  xs
    .reduce<readonly (readonly [number, number])[]>((runs, x) => {
      const last = runs.at(-1);
      return last && x === last[1] + 1 ? [...runs.slice(0, -1), [last[0], x]] : [...runs, [x, x]];
    }, [])
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(",");
