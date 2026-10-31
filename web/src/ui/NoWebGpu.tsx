/**
 * The whole page when this browser can't run the models: what eyespy needs, what is missing, what to try. The rest of
 * the app needs the engine, so none of it shows. chrome:// addresses are text, since pages can't link to them.
 */
import { NO_WEBGPU_TEXT as T } from "./help.ts";

const CANIUSE_URL = "https://caniuse.com/webgpu";
const STATUS_URL = "https://github.com/gpuweb/gpuweb/wiki/Implementation-Status";

export function NoWebGpu({ kind }: { kind: "no-webgpu" | "no-adapter" }) {
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
          <h3>What you can do</h3>
          <p>{T.todo[kind]}</p>
          {kind === "no-adapter" && (
            <p>
              {T.gpuPage.before}
              <code>{T.gpuPage.page}</code>
              {T.gpuPage.after}
            </p>
          )}
          <p>
            {T.where.before}
            <code>{T.where.flag}</code>
            {T.where.after}
          </p>
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
