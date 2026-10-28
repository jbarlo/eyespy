# eyespy

eyespy finds and catalogues the objects in a video, locally in your browser.

Give it a video (a walk past a fridge, a shelf, a garage). It picks keyframes, runs SAM 3 to find what you ask
for ("jar", "bottle", ...), and you group the detections into objects. The result is a catalogue: every object,
where it appears, and crops of it. Export it as a JSON manifest.

Everything runs on your machine. In the browser the models run on WebGPU (onnxruntime-web) and sessions live in the
browser's private storage (OPFS) or in a folder you pick. eyespy uploads nothing. The CLI does the same work in a
local server process (onnxruntime-node on WebGPU) that it starts for you.

## Web app

Needs a browser with WebGPU turned on.

```sh
pnpm install
pnpm --filter eyespy-web dev     # dev server
pnpm --filter eyespy-web build   # web/dist/index.html, a single file; serve it over http(s), not file://
```

## CLI

From the Nix devshell:

```sh
nix develop
pnpm install
eyespy init                       # makes the current folder a session (.eyespy/)
eyespy add frames --fps 4         # a folder of frames: pick keyframes and encode them
eyespy find jar                   # detections for a prompt
eyespy --help
```

The CLI doesn't read video files. A clip is a folder of still images (JPEG or PNG, read in natural name order, so
`2.jpg` comes before `10.jpg`). Extract the frames with any tool first, for example ffmpeg:

```sh
mkdir frames && ffmpeg -i clip.mov -vf fps=4 -q:v 2 frames/%06d.jpg && eyespy add frames --fps 4
```

`--fps` is the frame rate of the folder. A folder of every frame, added at the video's frame rate, gives the same
keyframes the web app picks from the video itself. Without `--fps` the folder is a set of photos and every photo is a
keyframe. All frames of a clip must be the same size after EXIF rotation. eyespy identifies a clip by its frames'
names and bytes, so a moved or renamed folder is the same clip. A clip's capture time is the first frame's EXIF date, if it has one.

`eyespy` starts `eyespy-server` for the session on first use, and the server exits when idle. A session is any folder
with an `.eyespy/` folder in it. The CLI finds it from the working directory the way git finds `.git`. The web app can
open the same folder.

## Models

eyespy uses SAM 3 (detector, vision and text encoders) and DINOv2-small as ONNX files. They are not part of this
repository. They are on Hugging Face at [jbarlo/eyespy-models](https://huggingface.co/jbarlo/eyespy-models), with
their own licences next to them. The web app downloads them on first use from a pinned commit of that repo, checks
each sha256, and caches them in OPFS. The CLI reads them from `models/onnx/` in the checkout, or from
`$EYESPY_MODELS`.

## Checks

`pnpm verify` runs them all.

## Licence

Copyright 2026 James Barlow. Apache-2.0, see LICENSE. Dependencies and the models have their own licences, listed in
THIRD_PARTY.md. SAM 3 is under Meta's SAM License, which is not open source. `pnpm licenses:check` enforces the npm
side.
