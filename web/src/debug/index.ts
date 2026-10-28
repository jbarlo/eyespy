/**
 * Bare debug page for the browser engine. It reads the engine's URL parameters, plus `agree=1`, which treats
 * the SAM License as accepted (FOR TESTING ONLY). Without `agree=1` it uses the app's stored agreement, and without
 * that it starts without SAM 3.
 */
import { browserStorage } from "../browser.ts";
import { createEyespy } from "../engine/client.ts";
import type { EngineEvent, SessionLocation, EyespyApi } from "../engine/client.ts";
import { pageParams } from "../engine/params.ts";
import { agreedTo, recordAgreement } from "../state/licence.ts";
import { SAM_LICENCE_TEXT } from "../ui/help.ts";
import { DEBUG_CSS, DEBUG_HTML } from "./markup.ts";

declare const __EYESPY_REV__: string;
declare const __EYESPY_SAM_LICENSE_SHA256__: string;

document.title = "eyespy engine (debug)";
document.head.append(Object.assign(document.createElement("style"), { textContent: DEBUG_CSS }));
document.body.innerHTML = DEBUG_HTML;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = pageParams(location.search);
const say = (s: string) => ($("status").textContent = s);
const log = (s: string) => {
  const el = $("log");
  el.textContent += s + "\n";
  el.scrollTop = el.scrollHeight;
};

const bars = new Map<string, HTMLProgressElement>();
function onEvent(e: EngineEvent) {
  window.eyespyEvents.push(e);
  if (e.kind === "download") {
    let bar = bars.get(e.name);
    if (!bar) {
      const row = document.createElement("div");
      bar = document.createElement("progress");
      row.append(bar, ` ${e.name}`);
      const note = document.createElement("span");
      note.className = "note";
      row.append(note);
      $("downloads").append(row);
      bars.set(e.name, bar);
    }
    bar.max = e.total;
    bar.value = e.loaded;
    (bar.parentElement!.querySelector(".note") as HTMLElement).textContent =
      ` ${(e.loaded / 2 ** 20).toFixed(0)} / ${(e.total / 2 ** 20).toFixed(0)} MiB${e.done ? ` (${e.source})` : ""}`;
  } else if (e.kind === "progress") say(`${e.stage}: ${Math.round(e.fraction * 100)}% of ${e.file}`);
  else if (e.kind === "unsupported") say(`can't decode ${e.file}: ${e.reason}`);
  else if (e.kind === "log") log(e.text);
  else if (e.kind === "ready") log(`engine ready on ${e.root}, ${e.device}`);
}

const testAgree = new URLSearchParams(location.search).get("agree") === "1";
const samAgreed = () => testAgree || agreedTo(browserStorage.prefs, __EYESPY_SAM_LICENSE_SHA256__);
$("licence-text").textContent = SAM_LICENCE_TEXT.intro;

let current: { dispose: () => void } | null = null;
let currentSession: SessionLocation = { opfs: params.session ?? "default" };
async function start(session: SessionLocation): Promise<EyespyApi> {
  current?.dispose();
  currentSession = session;
  const samLicenseAgreed = samAgreed();
  $("licence").hidden = samLicenseAgreed;
  window.eyespyEvents = [];
  say("starting engine…");
  const v = await createEyespy({
    session,
    models: params.models,
    runtime: params.runtime,
    detector: params.detector,
    onEvent,
    host: { eyespy: __EYESPY_REV__ },
    samLicenseAgreed,
  });
  current = v;
  window.eyespy = v.api;
  $("root").textContent = `${v.info.root} — ${v.info.device}`;
  const st = await v.api.status();
  $("clip").textContent = st.clips
    .map((c: { path: string; keyframes: number }) => `${c.path}: ${c.keyframes} keyframes`)
    .join(", ");
  say("ready");
  return v.api;
}

window.eyespyEvents = [];
window.eyespyReady = start(currentSession).catch((e: unknown) => {
  say(`failed: ${e instanceof Error ? e.message : String(e)}`);
  throw e;
});

$("folder").onclick = async () => {
  const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (!picker) {
    say("this browser has no showDirectoryPicker");
    return;
  }
  const dir = await picker({ mode: "readwrite" });
  window.eyespyReady = start({ dir });
};

$("video").onchange = async () => {
  const f = $<HTMLInputElement>("video").files?.[0];
  if (!f) return;
  const api = await window.eyespyReady!;
  say(`adding ${f.name}…`);
  const t = performance.now();
  try {
    const r = await api.addFile(f);
    $("clip").textContent =
      `${r.clip}: ${r.keyframes} keyframes from #${r.first} (${((performance.now() - t) / 1000).toFixed(1)} s)`;
    say("ready");
  } catch (e) {
    say(`add failed: ${(e as Error).message}`);
  }
};

$("agree").onclick = () => {
  recordAgreement(browserStorage.prefs, __EYESPY_SAM_LICENSE_SHA256__, new Date());
  window.eyespyReady = start(currentSession);
};

$("prepare").onclick = async () => {
  const api = await window.eyespyReady!;
  say("downloading models…");
  await api.prepare();
  say("models ready");
};

$("find").onclick = async () => {
  const api = await window.eyespyReady!;
  const prompt = $<HTMLInputElement>("prompt").value,
    frames = $<HTMLInputElement>("frames").value;
  say(`find ${prompt}…`);
  try {
    const r = await api.find({ prompt, frames });
    const out = $("out");
    out.textContent = `${r.hits.length} hits in ${r.seconds} s; present on ${JSON.stringify(r.present)}`;
    if (r.image) {
      const img = document.createElement("img");
      img.src = r.image;
      out.append(img);
    }
    say("ready");
  } catch (e) {
    say(`find failed: ${(e as Error).message}`);
  }
};
