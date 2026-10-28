/** Keyframe thumbnails and scrubber; the scrubber moves by position, not frame number (removed clips leave gaps). */
import { useEffect, useRef } from "react";
import { objColor } from "../state/index.ts";
import { useActions, useApp, useAssetVersion, useDerived, useSlice } from "./context.tsx";

export function Filmstrip() {
  const { assets, select } = useApp();
  const a = useActions();
  const fr = useSlice("frames", (s) => s.frames);
  const current = useSlice("frames", (s) => s.current);
  const pres = useDerived((s) => s.presenceFrames());
  const focus = useDerived((s) => s.focusObj());
  const framePos = useDerived((s) => s.framePos());
  useAssetVersion(assets.thumbs);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-frame="${current}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);
  // keyed on the frames themselves, so a set of the same size (a clip removed and another added) still gets its
  // thumbnails
  const { requestThumbs } = a;
  useEffect(() => requestThumbs(), [fr, requestThumbs]);
  if (!fr.length) return <div className="filmstrip empty" />;
  const n = fr.length;
  const pos = Math.max(0, framePos);
  const posOf: ReadonlyMap<number, number> = new Map(fr.map((f, k) => [f.frame, k]));
  const tick = focus ? objColor(focus) : undefined;
  return (
    <div className="filmstrip">
      <div className="strip" ref={strip} role="listbox" aria-label="Keyframes" aria-orientation="horizontal">
        {fr.map((f) => {
          const key = select.frameKey(f.frame);
          const thumb = key ? assets.thumbs.peek(key) : undefined;
          return (
            <button
              type="button"
              key={f.frame}
              role="option"
              aria-selected={current === f.frame}
              data-frame={f.frame}
              className={`thumb${current === f.frame ? " on" : ""}${f.encoded ? "" : " pending"}`}
              aria-label={`Keyframe ${f.frame}, ${f.t.toFixed(1)} s${pres.has(f.frame) ? `, ${focus} present` : ""}${f.encoded ? "" : ", not encoded yet"}`}
              onClick={() => a.setFrame(f.frame)}
            >
              {thumb ? <img src={thumb} alt="" /> : <span className="ph" />}
              <span className="cap">
                #{f.frame} · {f.t.toFixed(1)}s
              </span>
              {pres.has(f.frame) && <span className="pres" style={{ background: tick }} />}
            </button>
          );
        })}
      </div>
      <div className="scrub">
        <button type="button" aria-label="Previous keyframe (←)" onClick={() => a.stepFrame(-1)}>
          ◀
        </button>
        <div className="slider">
          <input
            type="range"
            min={0}
            max={n - 1}
            step={1}
            value={pos}
            aria-label="Keyframe"
            aria-valuetext={`Keyframe ${current}, ${pos + 1} of ${n}`}
            onChange={(e) => {
              const f = fr[Number(e.currentTarget.value)];
              if (f) a.setFrame(f.frame);
            }}
          />
          <div className="ticks" aria-hidden="true">
            {[...pres].flatMap((i) => {
              const k = posOf.get(i);
              return k === undefined
                ? []
                : [
                    <i
                      key={i}
                      style={{ left: `calc(${n > 1 ? k / (n - 1) : 0} * (100% - 14px) + 7px)`, background: tick }}
                    />,
                  ];
            })}
          </div>
        </div>
        <button type="button" aria-label="Next keyframe (→)" onClick={() => a.stepFrame(1)}>
          ▶
        </button>
        <span className="frame-no" aria-live="polite">
          #{current} · {pos + 1}/{n}
          {focus ? ` · ${focus} on ${pres.size}` : ""}
        </span>
      </div>
    </div>
  );
}
