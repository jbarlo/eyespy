# Third-party components and licences

This project's code is Apache-2.0 (`LICENSE`). This file lists every third-party component it ships or loads, its
licence, and how we comply. It is an engineering inventory, not legal advice.

## How it is distributed

| Channel | What reaches users | Third-party content |
|---|---|---|
| Web app on GitHub Pages | `dist/`: one `index.html` (page + inlined worker), `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt`, the model licences and notices under `models/` | npm packages bundled into `index.html`; ONNX Runtime wasm (fetched from jsDelivr); SAM 3 and DINOv2 model files (fetched from our Hugging Face repo, next row) |
| Model files on Hugging Face, `huggingface.co/jbarlo/eyespy-models` | `sam3/` (SAM 3 encoders, tokenizer, detectors, `LICENSE-SAM.txt`, `NOTICE-SAM.txt`), `dinov2-small/` (`model_cls.onnx`, `LICENSE.txt`, `NOTICE.txt`), a model card | we redistribute every model file the web app loads: SAM 3 under the SAM License, DINOv2 under Apache-2.0 |
| CLI and server, from source via the Nix flake | the repository; the user runs `pnpm install` (packages come from npm) and the flake's wrappers | we redistribute nothing. npm packages come from the user's own install; models are the user's local copies (`models/`) |
| `cli/dist/eyespy.mjs` (esbuild bundle) | nobody. The devshell wrapper builds it locally, and git ignores it | none. If it is ever published, set esbuild `legalComments` and ship a notices file like the web build does |

## Enforcement

- `pnpm licenses:check`, part of `pnpm verify`, runs `tools/licenses/check.js` against the allowlist and reviewed
  exceptions in `tools/licenses/policy.json`. Every production package needs an allowed licence or an exception.
- `web/scripts/notices.ts` is a Vite plugin that runs on every `vite build`. It writes `dist/THIRD_PARTY_NOTICES.txt`
  from the modules Rollup bundled (page and worker), with each package's LICENSE and NOTICE text plus the run-time
  components' full licence texts. It also copies the licence texts and model notices into `dist/`. A bundled package
  without a licence text fails the build. The app links the notices from the Licences section of Settings and from the
  empty-session screen.
- `third_party/` holds the upstream licence texts, verbatim (sources and hashes
  [below](#licence-texts-in-third_party)).

## Web app (GitHub Pages)

### npm packages bundled into `index.html`

All are permissive. Section A of `THIRD_PARTY_NOTICES.txt` meets their one condition, keeping the copyright and
licence notice with copies.

| Package | Licence |
|---|---|
| react 19.3.1, react-dom 19.3.1, scheduler 0.28.0 | MIT |
| zustand 5.0.16, zod 4.6.7, neverthrow 8.2.0, fflate 0.8.3 | MIT |
| @trpc/client 11.19.0, @trpc/server 11.19.0 | MIT |
| onnxruntime-web 1.30.0 (its prebuilt bundle includes onnxruntime-common; no flatbuffers/protobuf/long in it, checked from its source map) | MIT; the npm package has no licence file, so the text comes from `third_party/onnxruntime/LICENSE` |
| mp4box 2.4.1 | BSD-3-Clause |
| vite 8.3.5, rolldown 1.2.15 (small runtime helpers the bundler injects) | MIT |

No bundled package is Apache-2.0, so there are no NOTICE files to carry forward from the bundle.

### Loaded at run time

| Component | Where it comes from | Licence | How we comply |
|---|---|---|---|
| ONNX Runtime Web 1.30.0 wasm (`ort-wasm-simd-threaded.asyncify.wasm`) | `cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0`, sha256-pinned | MIT; the native code compiled in carries the notices in ORT's `ThirdPartyNotices.txt` | ORT LICENSE and the full ThirdPartyNotices.txt (v1.30.0) in `THIRD_PARTY_NOTICES.txt` (C.1) |
| SAM 3: `vision_fp16.onnx`, `text_fp16.onnx`, `tokenizer.json` | `huggingface.co/jbarlo/eyespy-models` at commit `7d55bf56`, `sam3/`, sha256-pinned; unchanged copies of `CardAnvilModels/sam3-ONNX` at commit `7eee2d79` | SAM License (Meta) | see [SAM 3](#sam-3-the-sam-license) |
| SAM 3 detectors: `detector_fp32_nosign.onnx`, `detector_fp16_nosign.onnx` | same repo and commit, `sam3/` | SAM License (derivative works) | see [SAM 3](#sam-3-the-sam-license) |
| DINOv2 small, `model_cls.onnx` | same repo and commit, `dinov2-small/` | Apache-2.0 | `LICENSE.txt` and `NOTICE.txt` (attribution; "modified: CLS Gather appended", §4(b)) beside the model on Hugging Face and under `models/dinov2-small/` in `dist/`; also C.3 in the notices |

Not shipped: `processor_config.json`, `tokenizer_config.json`, `vocab.json`, `merges.txt` (not in the manifest),
test clips and fixtures.

### SAM 3 (the SAM License)

- The licence is the SAM License, "Last Updated: November 19, 2025" (`third_party/sam3/LICENSE`, verbatim from
  `facebookresearch/sam3`; the CardAnvil repo's `LICENSE` at `7eee2d79` is the same text). It is not an open-source
  licence. `facebook/sam3` on Hugging Face says `license: other` and is gated.
- CardAnvil's files are a format conversion of `facebook/sam3`, distributed under the SAM License. Of their scripts
  we use only the graph split below, so their repo adds no terms beyond the SAM License.
- We modified both detectors and rewrote their Sign ops (`tools/models/README.md` has inputs, versions, commands and
  hashes). We exported fp32 to ONNX ourselves from `facebook/sam3` (HF revision `1aa50ce0`, `model.safetensors` sha256
  `6d06f0a5…cc14a`, the same weights CardAnvil used) with CardAnvil's graph split, then ran `patch_sign.py`. The graph
  split is `sam3_graphs.py` at `7eee2d79`, which we fetch and hash-check but don't vendor, because it carries no
  licence. fp16 is CardAnvil's `detector_fp16.onnx` at `7eee2d79` with `patch_sign.py` applied.

What we do for a public deploy:

- We distribute every SAM 3 file from `jbarlo/eyespy-models` with `sam3/LICENSE-SAM.txt` and `sam3/NOTICE-SAM.txt`
  beside them, and the model card names the licence. The site ships the licence and notice as
  `models/LICENSE-SAM.txt` and `models/NOTICE-SAM.txt`, puts them in `THIRD_PARTY_NOTICES.txt`, and links the licence
  before the download and in Settings. Our Apache-2.0 covers our code only.
- Everyone whose browser downloads the models uses them under the SAM License, so the app asks them to agree to
  the full text first (below).
- Meta can change the licence text. The weekly `sam-license` workflow compares it with upstream and opens a pull
  request when it changes (`tools/licenses/sam-license.js`).

The web app asks for explicit acceptance. Before any engine start, so before the first SAM 3 download or any use of
cached models, it shows a licence dialog ("I agree" or "Cancel") that links `models/LICENSE-SAM.txt` and the notices.
The browser stores the agreement as `eyespy.licence.sam`, holding `{sha256, at}`. It counts only for the licence text
this build ships, so a new text asks again. Cancel opens sessions without the models. The worker refuses SAM 3 files
without the agreement flag. Code: `web/src/state/licence.ts`, `web/src/engine/worker/licence.ts`.

The Hugging Face repo holds its own copies of the licence texts and notices, next to the files they cover. They
state the same facts as `third_party/`, so a change to one needs the same change in the other. The weekly
`sam-license` workflow fails while `sam3/LICENSE-SAM.txt` or `sam3/NOTICE-SAM.txt` differs from `third_party/sam3/`
on main; the owner uploads them with `hf upload`.

### Video decoding: no codec shipped

The web app reads MP4 and MOV with mp4box (BSD-3-Clause) and decodes with the browser's own decoders through
WebCodecs. No FFmpeg or other LGPL code and no codec implementation reaches users, so there are no LGPL duties and no
codec-patent exposure. The CLI and server read folders of still images (through sharp and libvips) and run no external
program. The devshell's ffmpeg is a development tool for the validation scripts, not part of eyespy.

### DINOv2

The `facebook/dinov2-small` weights are Apache-2.0, per the model card and the `facebookresearch/dinov2` LICENSE.
There is no upstream NOTICE file. The ONNX conversion comes from `onnx-community/dinov2-small`, which has no licence
of its own and is a format conversion of the base model. We appended a Gather (CLS token) and distribute
`model_cls.onnx` from `jbarlo/eyespy-models`. Apache-2.0 §4 asks for (a) a licence copy, which is `LICENSE.txt`
beside the model; (b) a modified-files notice and (c) attribution, both in `NOTICE.txt` beside it; and (d) the
upstream NOTICE, of which there is none. The site carries both files under `models/dinov2-small/`.

## CLI and server (run from source)

We don't redistribute these. `pnpm install` fetches every package from npm on the user's machine, and the flake
packages no `node_modules`. The licence check still enforces the production trees. The production packages of cli,
core, server and web (`node tools/licenses/check.js --list`) are:

| Licence | Packages |
|---|---|
| MIT | @trpc/client, @trpc/server, @commander-js/extra-typings, commander, neverthrow, tsx, esbuild, @esbuild/linux-x64, zod, fflate, onnxruntime-node, onnxruntime-common, onnxruntime-web, adm-zip, globalthis, define-properties, define-data-property, es-define-property, es-errors, gopd, has-property-descriptors, object-keys, matcher, escape-string-regexp, serialize-error, @img/colour, platform, @types/node, undici-types, react, react-dom, scheduler, zustand |
| BSD-3-Clause | mp4box, protobufjs, @protobufjs/{aspromise,base64,codegen,eventemitter,fetch,float,path,pool,utf8}, global-agent |
| Apache-2.0 | sharp, @img/sharp-linux-x64, detect-libc, flatbuffers, long, typescript (type-only peer of tRPC; ships ThirdPartyNoticeText.txt, not distributed) |
| ISC | semver, guid-typescript |
| MIT OR CC0-1.0 | type-fest |
| excepted | jimkit-cli, jimkit-completion (no licence), @img/sharp-libvips-linux-x64 (LGPL-3.0-or-later) |

Other platforms' optional native builds (esbuild, sharp, fsevents) get the same check there.

Exceptions (`tools/licenses/policy.json`):

- `jimkit-cli` and `jimkit-completion` 0.1.0 have no `license` field and no licence file in the published packages, so
  by default all rights are reserved. Their npm maintainer is `jbarlo`, the project owner. Only the CLI uses them.
- `@img/sharp-libvips-*` (LGPL-3.0-or-later; libvips plus LGPL-3 glib, pango, librsvg, libheif and others) is an
  unmodified prebuilt shared library that sharp loads, and we don't redistribute it. If we ever ship the server as a
  bundle, image or binary, LGPL-3.0 obligations apply (licence text, source or offer, replaceable library).

Dev-only packages not on the allowlist (never distributed): caniuse-lite (CC-BY-4.0, build-time data for
browserslist), lightningcss and lightningcss-linux-x64-gnu (MPL-2.0, Vite's CSS tool; none of it lands in the
bundle).

## NOTICE file for this project

None. The project has no attribution notices of its own. Third-party attributions are in `THIRD_PARTY_NOTICES.txt` and
the per-folder licence and notice files in `dist/` and on Hugging Face.

## Licence texts in third_party/

These are verbatim copies of the upstream files. `web/scripts/notices.ts` copies them into `dist/` and into
`THIRD_PARTY_NOTICES.txt`.

| File | Covers | Source | sha256 |
|---|---|---|---|
| `sam3/LICENSE` | SAM 3 encoders, tokenizer and detectors | <https://raw.githubusercontent.com/facebookresearch/sam3/main/LICENSE> (file last changed in commit `a13e358d`, "Initial commit"). Byte-identical (plus a final newline) to `LICENSE` in <https://huggingface.co/CardAnvilModels/sam3-ONNX/blob/7eee2d79268e794e433b6e49467c5340525ac228/LICENSE>. We have not compared the gated `facebook/sam3` HF repo's `LICENSE`. | `4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be` |
| `sam3/NOTICE` | SAM 3 files | ours: what they are, where they come from, what we changed | |
| `dinov2/LICENSE` | `model_cls.onnx` | <https://raw.githubusercontent.com/facebookresearch/dinov2/main/LICENSE> (Apache-2.0; the repo has no NOTICE file). The HF model card of `facebook/dinov2-small` (rev `ed25f3a3`) says `license: apache-2.0`; `onnx-community/dinov2-small` (rev `8b1f705a`) declares no licence of its own, only `base_model: facebook/dinov2-small`. | `600cc67cc4cb2f5ea317dcfc687ad1c74dc4bec8782bbe9db0afd83513b935b7` |
| `dinov2/NOTICE` | `model_cls.onnx` | ours: attribution and the modification notice (Apache-2.0 §4(b)) | |
| `onnxruntime/LICENSE` | onnxruntime-web (bundled) and the ORT wasm | <https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE> (MIT; the onnxruntime-web/-common npm packages ship no licence file) | `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c` |
| `onnxruntime/ThirdPartyNotices.txt` | the native code compiled into the ORT wasm | <https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt> | `143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3` |
