export const DEBUG_CSS = `
:root { color-scheme: light dark; --fg: #222; --bg: #fafafa; --muted: #777; --bar: #3b82f6; }
@media (prefers-color-scheme: dark) { :root { --fg: #ddd; --bg: #181818; --muted: #999; } }
body { font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 16px; max-width: 1100px; }
fieldset { border: 1px solid #8884; margin: 0 0 12px; }
label { margin-right: 12px; }
input[type="text"] { width: 12em; }
progress { width: 220px; vertical-align: middle; accent-color: var(--bar); }
#log { font: 12px/1.3 ui-monospace, monospace; white-space: pre-wrap; max-height: 220px; overflow: auto; color: var(--muted); }
#out img { max-width: 100%; display: block; margin-top: 8px; }
#status { font-weight: 600; }
`;

export const DEBUG_HTML = `
<h1>eyespy engine</h1>
<p id="status">starting…</p>
<fieldset id="licence" hidden>
  <legend>SAM License</legend>
  <p id="licence-text"></p>
  <p>Not accepted: the engine refuses the SAM 3 model files. <a href="models/LICENSE-SAM.txt">SAM License</a></p>
  <button id="agree">I agree</button>
</fieldset>
<fieldset>
  <legend>Session</legend>
  <button id="folder">Open folder…</button>
  <span id="root"></span>
</fieldset>
<fieldset>
  <legend>Video</legend>
  <input id="video" type="file" accept="video/*,.mov,.mp4,.m4v" />
  <span id="clip"></span>
</fieldset>
<fieldset>
  <legend>Models</legend>
  <button id="prepare">Download all</button>
  <div id="downloads"></div>
</fieldset>
<fieldset>
  <legend>Find</legend>
  <label>prompt <input id="prompt" type="text" value="jar" /></label>
  <label>frames <input id="frames" type="text" value="0-3" /></label>
  <button id="find">find</button>
  <div id="out"></div>
</fieldset>
<div id="log"></div>
`;
