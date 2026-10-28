import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Box } from "../state/index.ts";
import { useActions } from "./context.tsx";
import { PANEL_HELP } from "./help.ts";
import type { PanelId } from "./help.ts";
import { Info } from "./Info.tsx";

const VIDEO_ACCEPT = "video/*,.mov,.mp4,.m4v,.mkv,.webm,.avi";

export const fmtBytes = (n: number) =>
  n >= 2 ** 30
    ? `${(n / 2 ** 30).toFixed(2)}\u00a0GB`
    : n >= 2 ** 20
      ? `${(n / 2 ** 20).toFixed(0)}\u00a0MB`
      : `${(n / 2 ** 10).toFixed(0)}\u00a0KB`;

/** A detection's region cut from its keyframe (client-side, at display size), with its box drawn. */
export function Crop({
  det,
  size = 88,
  label,
}: {
  readonly det: { readonly id: string; readonly frame: number; readonly box: Box };
  readonly size?: number;
  readonly label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { cropBitmap } = useActions();
  const dpr = devicePixelRatio || 1;
  const px = Math.max(1, Math.round(size * dpr));
  // primitives as deps, because `det` (and its box array) is a fresh object after every refresh
  const { id, frame } = det;
  const [x0, y0, x1, y1] = det.box;
  useEffect(() => {
    const gone = new AbortController();
    void cropBitmap({ id, frame, box: [x0, y0, x1, y1] }, size, dpr).then((bm) => {
      const g = ref.current?.getContext("2d");
      if (!gone.signal.aborted && bm?.width && g) g.drawImage(bm, 0, 0);
    });
    return () => gone.abort();
  }, [cropBitmap, id, frame, x0, y0, x1, y1, size, dpr]);
  return (
    <canvas
      ref={ref}
      className="crop"
      width={px}
      height={px}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Crop of detection ${det.id}`}
      data-det-id={det.id}
    />
  );
}

/** A side panel; its title's tooltip and info button come from PANEL_HELP. */
export function Panel({
  id,
  title,
  children,
  open = true,
  badge,
}: {
  readonly id: PanelId;
  readonly title: string;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly badge?: string | number;
}) {
  return (
    <details className="panel" id={`panel-${id}`} open={open}>
      <summary>
        <span title={PANEL_HELP[id].tip}>{title}</span>
        <Info help={PANEL_HELP[id]} />
        {badge !== undefined && badge !== "" && <span className="badge">{badge}</span>}
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}

/**
 * A native `input` listener for a controlled input. React skips onChange when a script sets `el.value` before
 * dispatching `input`, because its value tracker sees no change, and automation drives sliders that way.
 * Pair it with the usual onChange. Both may run, so handlers must be idempotent.
 */
export function useNativeInput(onValue: (v: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef(onValue);
  useEffect(() => {
    latest.current = onValue;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => latest.current(el.value);
    el.addEventListener("input", h);
    return () => el.removeEventListener("input", h);
  }, []);
  return ref;
}

/** A video picker; remounted after each pick so the same file can be picked again. */
export function VideoInput({
  label,
  id,
  onFile,
}: {
  readonly label: string;
  readonly id?: string;
  readonly onFile: (f: File) => void;
}) {
  const [gen, setGen] = useState(0);
  return (
    <input
      key={gen}
      type="file"
      accept={VIDEO_ACCEPT}
      aria-label={label}
      id={id}
      onChange={(e) => {
        const f = e.currentTarget.files?.[0];
        setGen((g) => g + 1);
        if (f) onFile(f);
      }}
    />
  );
}
