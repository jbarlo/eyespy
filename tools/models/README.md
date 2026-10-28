# Building the SAM 3 detectors (tools/models)

The web app uses two SAM 3 detector graphs derived from Meta's weights, `detector_fp32_nosign.onnx` and
`detector_fp16_nosign.onnx` (`models/onnx/` locally, `sam3/` in the Hugging Face repo `jbarlo/eyespy-models`). The
vision and text encoders are Card Anvil's files, unmodified. The commands below rebuild both detectors bit for bit.

| File | What it does |
|---|---|
| `export_detector.py` | builds the detector graph from `Sam3Model` (fp32, eager attention) and exports it with `torch.onnx.export` (dynamo, opset 18) |
| `patch_sign.py` | rewrites each `Sign` node, which the WebGPU provider lacks, as `Cast(x>0) - Cast(x<0)` |
| `strip_metadata.py` | drops `metadata_props` and doc strings |
| `same_graph.py` | compares two ONNX files, ignoring metadata |

The fp16 detector is Card Anvil's `detector_fp16.onnx` with Sign patched and metadata stripped.

## Inputs

| Input | Pin |
|---|---|
| SAM 3 weights | `facebook/sam3` (gated) at revision `1aa50ce07302cb375f85d8084b68a0fb378b8d85`; `model.safetensors` sha256 `6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a`. Local copy: `models/sam3/` (`hf download facebook/sam3 --local-dir models/sam3`) |
| Graph split | `sam3_graphs.py` from <https://huggingface.co/CardAnvilModels/sam3-ONNX> at `7eee2d79268e794e433b6e49467c5340525ac228`, sha256 `e46f7f9da14531adf4d8d1135cf791dc289bdb4346059748e9b3bcbaae670d01`. It has no licence of its own, so this repository doesn't include it. `export_detector.py` loads the downloaded file and refuses any other hash |
| fp16 source | `onnx/detector_fp16.onnx` from the same repo and commit, sha256 `89991506cc7e54e828227ca12a4ae015f4107b67a4216b9c2906ce7f7e349d17` (exported from `facebook/sam3` at `3c879f39`, same `model.safetensors`) |

## Environment

- Export runs in the flake's default devshell (Python 3.14.7, torch 2.13.0 CPU, transformers 5.17.0), plus onnx
  1.23.2, onnxscript 0.7.2 and onnx_ir 1.1.0 (ml_dtypes 0.6.0, protobuf 7.36.2) in a side folder on `PYTHONPATH`,
  without its numpy, sympy, mpmath, typing_extensions and packaging.
- Patch and strip run on any Python with onnx 1.23.2 (protobuf 7.36.2).

## Commands

From the repository root:

```sh
W=scratch/models
R=https://huggingface.co/CardAnvilModels/sam3-ONNX/resolve/7eee2d79268e794e433b6e49467c5340525ac228
mkdir -p $W/cardanvil
curl -sfL -o $W/cardanvil/sam3_graphs.py $R/sam3_graphs.py
curl -sfL -o $W/cardanvil/detector_fp16.onnx $R/onnx/detector_fp16.onnx

# onnx + onnxscript for the devshell's Python 3.14
uv pip install --target $W/pyext --python 3.14 onnx==1.23.2 onnxscript==0.7.2 onnx_ir==1.1.0
rm -rf $W/pyext/{numpy,sympy,mpmath,typing_extensions,packaging}* $W/pyext/isympy.py $W/pyext/bin $W/pyext/share

# venv for the patch and strip
uv venv $W/.venv -p 3.12 && uv pip install -p $W/.venv/bin/python onnx==1.23.2
P=$W/.venv/bin/python

# fp32: export, patch (writes one file with the weights inline), strip
PYTHONPATH=$W/pyext nix develop -c python3 tools/models/export_detector.py models/sam3 $W/cardanvil/sam3_graphs.py $W/fp32
$P tools/models/patch_sign.py $W/fp32/detector.onnx $W/fp32_nosign.onnx
$P tools/models/strip_metadata.py $W/fp32_nosign.onnx $W/detector_fp32_nosign.onnx

# fp16: patch Card Anvil's detector, strip
$P tools/models/patch_sign.py $W/cardanvil/detector_fp16.onnx $W/fp16_nosign.onnx
$P tools/models/strip_metadata.py $W/fp16_nosign.onnx $W/detector_fp16_nosign.onnx

sha256sum $W/detector_*_nosign.onnx
```

## Outputs

| File | Bytes | sha256 (matches `manifest.ts`) |
|---|---|---|
| `detector_fp32_nosign.onnx` | 102,036,400 | `58668cc33539a82f297c194e12b90c2bfccfb649f77a048c15dea84d1d6d3564` |
| `detector_fp16_nosign.onnx` | 51,125,743 | `d7d8796f9dabffadd3af2a157413dd8a39a5a12e9e04190410e693699baf7d91` |

The detector's inputs are `features_288`, `features_144`, `features_72` (vision encoder outputs), `text_features` and
`text_mask`. Its outputs are `pred_logits`, `pred_boxes` (normalized xyxy), `presence_logits`, `pred_masks` (288×288
logits) and `semantic_seg`.

## Licence

The outputs are derivative works of the SAM Materials, and we distribute them under the SAM License
(`third_party/sam3/LICENSE`; see `THIRD_PARTY.md`). The scripts in this folder are this project's code, under
Apache-2.0.
