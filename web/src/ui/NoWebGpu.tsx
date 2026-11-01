/**
 * The whole page when this browser can't run the models: what eyespy needs, what is missing, what to try in each
 * browser engine. This browser's engine is open, with only its OS's steps and the general ones. The rest of the app
 * needs the engine, so none of it shows. chrome:// and about: addresses are text, since pages can't link to them.
 */
import type { Platform } from "../state/ports.ts";
import { GPU_NOTE, NO_WEBGPU_TEXT as T, stepsFor } from "./help.ts";

const CANIUSE_URL = "https://caniuse.com/webgpu";
const STATUS_URL = "https://github.com/gpuweb/gpuweb/wiki/Implementation-Status";
const ENGINES = ["chromium", "gecko", "webkit"] as const;

/** Backticked parts of a step as code. */
const Step = ({ text }: { text: string }) => (
  <li>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</li>
);

export function NoWebGpu({ kind, platform }: { kind: "no-webgpu" | "no-adapter"; platform: Platform | null }) {
  const engines = ENGINES.toSorted((a, b) => Number(b === platform?.engine) - Number(a === platform?.engine));
  return (
    <div className="no-webgpu">
      <header className="topbar">
        <strong className="brand">eyespy</strong>
      </header>
      <main>
        <section role="alert" aria-labelledby="no-webgpu-title">
          <h2 id="no-webgpu-title">{T.title[kind]}</h2>
          <p>{T.how}</p>
          <p>{T.why[kind]}</p>
          <p>{GPU_NOTE}</p>
          <h3>What you can do</h3>
          <p>{T.todo[kind]}</p>
          {engines.map((e) => (
            <details key={e} open={e === platform?.engine}>
              <summary>{T.guides[e].name}</summary>
              <ul>
                {stepsFor(T.guides[e].steps, e === platform?.engine ? platform.os : null, kind).map((s) => (
                  <Step key={s.text} text={s.text} />
                ))}
              </ul>
            </details>
          ))}
          <p className="muted">
            {T.lists.before}
            <a href={CANIUSE_URL} target="_blank" rel="noreferrer">
              {T.lists.caniuse}
            </a>
            {T.lists.between}
            <a href={STATUS_URL} target="_blank" rel="noreferrer">
              {T.lists.status}
            </a>
            {T.lists.after}
          </p>
        </section>
      </main>
    </div>
  );
}
