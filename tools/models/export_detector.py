"""Export SAM 3's detector graph (fp32 ONNX) from the facebook/sam3 weights.

The graph split is Card Anvil's `sam3_graphs.py` (CardAnvilModels/sam3-ONNX), so the detector has
the same inputs and outputs as their `detector_fp16.onnx` and pairs with their vision and text
encoders. That file has no licence of its own, so this repository doesn't copy it. Pass the copy
fetched at the pinned commit (README.md), and this script checks its sha256.

Usage (in the flake's devshell, with onnx and onnxscript on PYTHONPATH, see README.md):
    python export_detector.py SAM3_DIR SAM3_GRAPHS_PY OUT_DIR

Writes OUT_DIR/detector.onnx and OUT_DIR/detector.onnx.data (external weights).
"""

import hashlib
import importlib.util
import sys
from pathlib import Path

import torch
from transformers import Sam3Model

# CardAnvilModels/sam3-ONNX at 7eee2d79268e794e433b6e49467c5340525ac228
SAM3_GRAPHS_SHA256 = "e46f7f9da14531adf4d8d1135cf791dc289bdb4346059748e9b3bcbaae670d01"


def load_graphs(path: Path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SAM3_GRAPHS_SHA256:
        sys.exit(f"{path}: sha256 {digest}, expected {SAM3_GRAPHS_SHA256}")
    spec = importlib.util.spec_from_file_location("sam3_graphs", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(sam3_dir: str, graphs_py: str, out_dir: str) -> None:
    g = load_graphs(Path(graphs_py))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    model = Sam3Model.from_pretrained(sam3_dir, attn_implementation="eager").eval()
    pixels = torch.zeros(1, 3, g.IMAGE_SIZE, g.IMAGE_SIZE)
    ids = torch.zeros(1, g.TEXT_TOKENS, dtype=torch.long)
    mask = torch.ones(1, g.TEXT_TOKENS, dtype=torch.long)
    vision = g.Sam3Vision(model).eval()
    text = g.Sam3Text(model).eval()
    with torch.no_grad():
        levels = vision(pixels)
        feats = text(ids, mask)

    detector = g.Sam3Detector(model, g.position_encoding_72(model)).eval()
    print("exporting detector", flush=True)
    with torch.no_grad():
        torch.onnx.export(
            detector,
            (*levels, feats, mask),
            str(out / "detector.onnx"),
            input_names=["features_288", "features_144", "features_72", "text_features", "text_mask"],
            output_names=["pred_logits", "pred_boxes", "presence_logits", "pred_masks", "semantic_seg"],
            opset_version=18,
            dynamo=True,
            external_data=True,
            optimize=True,
        )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: python export_detector.py SAM3_DIR SAM3_GRAPHS_PY OUT_DIR")
    main(*sys.argv[1:])
