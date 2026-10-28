/**
 * The "?" info button. Its tooltip is the help's one-liner, and a click opens the full text in a native popover. It is
 * safe inside a <label> or <summary>, because a click in the popover doesn't toggle the checkbox or the panel.
 */
import { useId, useRef } from "react";
import type { Help } from "./help.ts";

const W = 340;

/** Under the button (above it when there's no room), inside the viewport with a gutter. */
function place(pop: HTMLElement, anchor: HTMLElement | null) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(W, innerWidth - 32);
  pop.style.setProperty("width", `${w}px`);
  pop.style.setProperty("left", `${Math.max(16, Math.min(r.left - 8, innerWidth - w - 16))}px`);
  const h = pop.offsetHeight;
  const below = r.bottom + 6;
  pop.style.setProperty("top", `${below + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below}px`);
}

export function Info({ help }: { readonly help: Help }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        className="info"
        ref={btn}
        popoverTarget={id}
        aria-label={`About ${help.label}`}
        title={help.tip}
        data-help={help.label}
      >
        ?
      </button>
      <div
        id={id}
        popover="auto"
        className="info-pop"
        role="note"
        aria-label={help.label}
        onToggle={(e) => {
          if (e.newState === "open") place(e.currentTarget, btn.current);
        }}
        onClick={(e) => e.preventDefault()}
      >
        <strong>{help.label}</strong>
        <p>{help.tip}</p>
        {help.more && <p className="muted">{help.more}</p>}
      </div>
    </>
  );
}
