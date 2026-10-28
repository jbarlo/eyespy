/** The settings dialog. */
import { useCallback, useEffect, useState } from "react";
import { CONFIG_KEYS } from "eyespy-core/session/pure";
import type { ConfigKey } from "eyespy-core/session/pure";
import { FEATURE_CACHE_CHOICES, FEATURE_DISK_CHOICES } from "../../state/index.ts";
import type { Detector, SessionRow, StorageSummary } from "../../state/index.ts";
import { fmtBytes } from "../common.tsx";
import { useActions, useSlice } from "../context.tsx";
import { HELP, PREFERENCE_HELP, budgetLabel, keyframesInMB, reencodeTime, settingHelp } from "../help.ts";
import { Info } from "../Info.tsx";
import { Dialog } from "./Dialog.tsx";

const asDetector = (v: string): Detector => (v === "fp16" ? "fp16" : "fp32");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Session settings the app shows, without idle_minutes, which configures only the CLI's server. */
const SHOWN_SETTINGS = CONFIG_KEYS.filter((k) => k !== "idle_minutes");

export function SettingsDialog() {
  const a = useActions();
  const open = useSlice("settings", (s) => s.open);
  return (
    <Dialog open={open} label="Settings" onClose={() => a.openSettings(false)}>
      <SettingsBody />
    </Dialog>
  );
}

function SettingsBody() {
  const a = useActions();
  const [sum, setSum] = useState<StorageSummary | null>(null);
  const { storageSummary } = a;
  const load = useCallback(() => storageSummary().then(setSum), [storageSummary]);
  // this mounts when the dialog opens, so it measures once per opening and again after each drop or budget change
  useEffect(() => void load(), [load]);
  return (
    <div className="dialog settings">
      <h3>Settings</h3>
      <StorageSection sum={sum} load={load} />
      <FeatureSection sum={sum} load={load} />
      <DetectorSection />
      <SessionSettings />
      <Licences />
      <div className="actions end">
        <button type="button" className="primary" onClick={() => a.openSettings(false)}>
          Close
        </button>
      </div>
    </div>
  );
}

/** The storage summary the dialog measured (null while measuring) and how to measure again. */
type Measured = { readonly sum: StorageSummary | null; readonly load: () => Promise<void> };

function StorageSection({ sum, load }: Measured) {
  const a = useActions();
  const persistOn = useSlice("settings", (s) => s.persistFeatures);
  const budgetMB = useSlice("settings", (s) => s.featureDiskMB);
  const [msg, setMsg] = useState("");
  const again = persistOn ? " Keep image features on disk is on, so they are saved again as they are re-encoded." : "";
  const dropOne = async (s: SessionRow) => {
    const ok = await a.ask(
      `Drop the stored image features of “${s.name}” (${fmtBytes(s.features)}, ${plural(s.keyframes, "keyframe")})? ` +
        `Detections, objects and labels stay. Searching ${s.keyframes === 1 ? "that keyframe" : "those keyframes"} ` +
        `again encodes ${s.keyframes === 1 ? "it" : "them"} first: ` +
        `${reencodeTime(s.keyframes)} on a mid-range GPU.${s.open ? again : ""}`,
      "Drop features",
    );
    if (!ok) return;
    const n = await a.dropSessionFeatures(s.name);
    setMsg(`Dropped ${plural(n, s.open ? "feature file" : "feature folder")} of ${s.name}.`);
    await load();
  };
  const dropAll = async () => {
    if (!sum) return;
    const kf = sum.sessions.reduce((n, s) => n + s.keyframes, 0);
    const ok = await a.ask(
      `Drop the stored image features of every browser session (${fmtBytes(sum.features)}, ` +
        `${plural(kf, "keyframe")})? Detections, objects and labels stay. Keyframes are re-encoded when a search ` +
        `needs them: ${reencodeTime(kf)} in all on a mid-range GPU.${again}`,
      "Drop features",
    );
    if (!ok) return;
    const n = await a.clearFeatures();
    setMsg(`Dropped features (${n} folder${n === 1 ? "" : "s"} or files).`);
    await load();
  };
  return (
    <section>
      <h4>Storage</h4>
      {!sum ? (
        <p className="muted">Measuring…</p>
      ) : (
        <>
          <table className="usage">
            <tbody>
              <tr>
                <th>
                  {HELP.storageUsed.label} <Info help={HELP.storageUsed} />
                </th>
                <td>
                  {fmtBytes(sum.used)} of {fmtBytes(sum.quota)}
                  {sum.share !== null && ` (${(sum.share * 100).toFixed(sum.share < 0.1 ? 1 : 0)}%)`}
                </td>
              </tr>
              <tr>
                <th>
                  {HELP.models.label} <Info help={HELP.models} />
                </th>
                <td>{fmtBytes(sum.models)}</td>
              </tr>
              <tr>
                <th>
                  {HELP.persisted.label} <Info help={HELP.persisted} />
                </th>
                <td>{sum.persisted ? "yes" : <PersistAsk onDone={load} />}</td>
              </tr>
            </tbody>
          </table>
          <div className="scroll">
            <table className="usage sessions" aria-label="Browser sessions">
              <thead>
                <tr>
                  <th>Browser session</th>
                  <th className="num">
                    {HELP.features.label} <Info help={HELP.features} />
                  </th>
                  <th className="num">
                    {HELP.otherData.label} <Info help={HELP.otherData} />
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sum.sessions.map((s) => (
                  <tr key={s.name} className={s.open ? "open" : ""} data-session-usage={s.name}>
                    <th>
                      {s.name}
                      {s.open && <span className="muted"> (open)</span>}
                    </th>
                    <td className="num" title={`${plural(s.keyframes, "keyframe")} stored`}>
                      {fmtBytes(s.features)}
                      {budgetMB !== null && (
                        <span className={s.features > budgetMB * 2 ** 20 ? "warn-text" : "muted"}>
                          {" "}
                          of {budgetLabel(budgetMB)}
                        </span>
                      )}
                    </td>
                    <td className="num">{fmtBytes(s.other)}</td>
                    <td>
                      <button
                        type="button"
                        className="danger"
                        disabled={!s.features}
                        title={HELP.dropFeatures.tip}
                        aria-label={`Drop features of ${s.name}`}
                        onClick={() => void dropOne(s)}
                      >
                        {HELP.dropFeatures.label}
                      </button>
                    </td>
                  </tr>
                ))}
                {!sum.sessions.length && (
                  <tr>
                    <td className="muted" colSpan={4}>
                      No browser sessions yet.
                    </td>
                  </tr>
                )}
              </tbody>
              {sum.sessions.length > 1 && (
                <tfoot>
                  <tr>
                    <th>All sessions</th>
                    <td className="num">{fmtBytes(sum.features)}</td>
                    <td className="num">{fmtBytes(sum.sessionsTotal - sum.features)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="opt">
            <button
              type="button"
              className="danger"
              disabled={!sum.features}
              title={HELP.dropAllFeatures.tip}
              onClick={() => void dropAll()}
            >
              {HELP.dropAllFeatures.label}
            </button>
            <Info help={HELP.dropAllFeatures} />
            {msg && (
              <span className="muted small" role="status">
                {msg}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** "no" plus the eviction risk, and a button to ask the browser again. */
function PersistAsk({ onDone }: { readonly onDone: () => Promise<void> }) {
  const a = useActions();
  const answered = useSlice("settings", (s) => s.persisted);
  return (
    <span>
      <span className="warn-text">no</span>
      <span className="muted small"> (the browser may clear it when the disk runs low) </span>
      <button
        type="button"
        className="link"
        title="Ask the browser again (navigator.storage.persist())"
        onClick={async () => {
          await a.requestPersist();
          await onDone();
        }}
      >
        {answered === false ? "Ask again" : "Ask the browser"}
      </button>
    </span>
  );
}

function FeatureSection({ sum, load }: Measured) {
  const a = useActions();
  const persist = useSlice("settings", (s) => s.persistFeatures);
  const diskMB = useSlice("settings", (s) => s.featureDiskMB);
  const [evicted, setEvicted] = useState("");
  const mine = sum?.sessions.find((s) => s.open);
  const setBudget = async (mb: number | null) => {
    const n = await a.setFeatureDiskMB(mb);
    setEvicted(n ? `Deleted the features of the ${plural(n, "keyframe")} used longest ago.` : "");
    await load();
  };
  const cacheMB = useSlice("settings", (s) => s.featureCacheMB);
  const P = PREFERENCE_HELP;
  return (
    <section>
      <h4>Image features</h4>
      <div className="opt">
        <label title={P.persistFeatures.tip}>
          <input
            type="checkbox"
            checked={persist}
            aria-label={P.persistFeatures.label}
            onChange={(e) => void a.setPersistFeatures(e.currentTarget.checked)}
          />
          {P.persistFeatures.label}
        </label>
        <Info help={P.persistFeatures} />
      </div>
      <p className="muted small">{P.persistFeatures.tip}</p>
      <div className="opt">
        <label title={P.featureDiskMB.tip}>
          {P.featureDiskMB.label}
          <select
            aria-label={P.featureDiskMB.label}
            value={diskMB ?? "unlimited"}
            onChange={(e) => {
              const v = e.currentTarget.value;
              void setBudget(v === "unlimited" ? null : Number(v));
            }}
          >
            {FEATURE_DISK_CHOICES.map((mb) => (
              <option key={mb ?? "unlimited"} value={mb ?? "unlimited"}>
                {mb === null ? "Unlimited" : `${budgetLabel(mb)} (about ${keyframesInMB(mb)} keyframes)`}
              </option>
            ))}
          </select>
        </label>
        <Info help={P.featureDiskMB} />
      </div>
      <p className="muted small" data-disk-budget>
        {mine &&
          `This session: ${fmtBytes(mine.features)} of ${budgetLabel(diskMB)} ` +
            `(${plural(mine.keyframes, "keyframe")} stored). `}
        {P.featureDiskMB.tip}
        {evicted && (
          <span role="status" className="evicted">
            {evicted}
          </span>
        )}
      </p>
      <div className="opt">
        <label title={P.featureCacheMB.tip}>
          {P.featureCacheMB.label}
          <select
            aria-label={P.featureCacheMB.label}
            value={cacheMB}
            onChange={(e) => a.setFeatureCacheMB(Number(e.currentTarget.value))}
          >
            {FEATURE_CACHE_CHOICES.map((mb) => (
              <option key={mb} value={mb}>
                {mb / 1024} GB (about {keyframesInMB(mb)} keyframes)
              </option>
            ))}
          </select>
        </label>
        <Info help={P.featureCacheMB} />
      </div>
      <p className="muted small">Applies when the session is reopened.</p>
    </section>
  );
}

function DetectorSection() {
  const a = useActions();
  const detector = useSlice("settings", (s) => s.detector);
  const P = PREFERENCE_HELP;
  return (
    <section>
      <h4>Detector</h4>
      <div className="opt">
        <label title={P.detector.tip}>
          {P.detector.label}
          <select
            aria-label={P.detector.label}
            value={detector}
            onChange={(e) => a.setDetector(asDetector(e.currentTarget.value))}
          >
            <option value="fp32">fp32 (full precision)</option>
            <option value="fp16">fp16 (half the download, scores differ slightly)</option>
          </select>
        </label>
        <Info help={P.detector} />
      </div>
      <p className="muted small">Applies when the session is reopened.</p>
    </section>
  );
}

function SessionSettings() {
  const ready = useSlice("engine", (s) => s.phase === "ready");
  return (
    <section>
      <details>
        <summary>
          {HELP.sessionSettings.label} <Info help={HELP.sessionSettings} />
        </summary>
        <p className="muted small">{HELP.sessionSettings.tip}</p>
        {ready ? (
          <div className="cfg">
            {SHOWN_SETTINGS.map((k) => (
              <SettingRow key={k} k={k} />
            ))}
          </div>
        ) : (
          <p className="muted">No session open.</p>
        )}
      </details>
    </section>
  );
}

function SettingRow({ k }: { readonly k: ConfigKey }) {
  const a = useActions();
  const value = useSlice("engine", (s) => s.config[k]);
  const h = settingHelp(k);
  const commit = (v: string) => {
    const n = Number(v);
    if (v.trim() !== "" && !Number.isNaN(n) && n !== value) void a.setSetting(k, n);
  };
  return (
    <>
      <span title={h.tip}>{h.label}</span>
      <Info help={h} />
      <input
        key={value}
        type="number"
        step="any"
        aria-label={h.label}
        data-setting={k}
        defaultValue={value}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
      />
    </>
  );
}

/** Licence files the build writes next to index.html; absent on the dev server. */
function Licences() {
  return (
    <section>
      <h4>Licences</h4>
      <p className="muted small">
        This app is open source (<a href="LICENSE.txt">Apache-2.0</a>). It bundles and downloads third-party code and
        models under their own licences: <a href="THIRD_PARTY_NOTICES.txt">third-party notices</a>. The SAM 3 models are
        under Meta&apos;s <a href="models/LICENSE-SAM.txt">SAM License</a>, which has use restrictions.
      </p>
    </section>
  );
}
