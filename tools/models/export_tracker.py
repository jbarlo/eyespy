"""Export SAM 3's video tracker graphs (fp32 ONNX) from the facebook/sam3 weights.

Everything comes from `Sam3VideoModel.from_pretrained(SAM3_DIR)`, the transformers modules and the pinned
`model.safetensors`, whose hash this script checks. Nothing comes from another exporter.

The graphs run one object and one frame with the memory bank outside them. A frame's trunk goes through `neck` once.
Seeding runs `mask_embed`, `decoder` and `memenc`. Propagating runs `attn_l0` to `attn_l3`, one at a time so that the
worker can yield between them, and then `decoder` and `memenc`. Every graph takes an object batch on axis 0.

| Graph | Inputs | Outputs |
|---|---|---|
| neck | trunk [1,1024,72,72] | s0 [1,32,288,288], s1 [1,64,144,144], f72 [1,256,72,72] |
| mask_embed | mask [N,1,288,288], 0 or 1 | dense [N,256,72,72] |
| decoder | s0, s1, feat [N,256,72,72], dense [N,256,72,72] | low_res [N,1,288,288], iou [N,1], score [N,1,1], pointer [N,256] |
| memenc | f72, mask [N,1,288,288] logits, score [N,1,1], binarize [] 0 or 1 | mem [N,64,72,72] |
| attn_l0 | x = f72 [N,256,72,72], spatial, spatial_pos [N,S,64], pointer, pointer_pos [N,P,64] | y [N,5184,256] |
| attn_l1, attn_l2 | x = y of the layer before, then as attn_l0 | y [N,5184,256] |
| attn_l3 | as attn_l1 | y [N,256,72,72] |
| tables | none | mem_pos, mem_tpos, tproj_w, tproj_b, no_mask |

`binarize` is a float because the runtime port has no boolean tensor. S is a multiple of 5184.

The rotary tables are not stored in the attention graphs. Each layer computes them from `inv_freq` and the grid with
the upstream code, as a part of the graph with no inputs, so ORT folds it when it creates the session.

Usage (in the flake's devshell, with onnx and onnxscript on PYTHONPATH, see README.md):
    python export_tracker.py SAM3_DIR OUT_DIR

Writes OUT_DIR/{neck,mask_embed,decoder,memenc,attn_l0..3}_fp32.onnx and OUT_DIR/tables.onnx, without metadata.
"""

import hashlib
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import Sam3VideoModel

import onnx
from onnx import TensorProto, helper, numpy_helper

from strip_metadata import strip

# facebook/sam3 at 1aa50ce07302cb375f85d8084b68a0fb378b8d85
WEIGHTS_SHA256 = "6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a"

GRID = 72
TOKENS = GRID * GRID
HIDDEN = 256
MEM = 64
IMAGE = 1008
MASK = 288
# The memory encoder's input side, four times the low-res mask (_encode_new_memory).
MEM_MASK = MASK * 4
LAYERS = 4


def resize(x: torch.Tensor, size: int) -> torch.Tensor:
    return F.interpolate(x, size=(size, size), mode="bilinear", align_corners=False)


class Neck(nn.Module):
    """get_vision_features_for_tracker, on the vision encoder's trunk."""

    def __init__(self, model):
        super().__init__()
        self.fpn = model.tracker_neck.fpn_layers
        self.conv_s0 = model.tracker_model.mask_decoder.conv_s0
        self.conv_s1 = model.tracker_model.mask_decoder.conv_s1

    def forward(self, trunk):
        return self.conv_s0(self.fpn[0](trunk)), self.conv_s1(self.fpn[1](trunk)), self.fpn[2](trunk)


class MaskEmbed(nn.Module):
    """The dense prompt _use_mask_as_output gets out of a binary mask."""

    def __init__(self, tracker):
        super().__init__()
        self.downsample = tracker.mask_downsample
        self.embed = tracker.prompt_encoder.mask_embed

    def forward(self, mask):
        return self.embed(resize(self.downsample(resize(mask, IMAGE)), MASK))


class Decoder(nn.Module):
    """_single_frame_forward with no points and with multimask, keeping the mask with the best predicted IoU."""

    def __init__(self, tracker):
        super().__init__()
        self.decoder = tracker.mask_decoder
        self.pointer_proj = tracker.object_pointer_proj
        self.no_pointer = tracker.no_object_pointer
        self.register_buffer("pos", tracker.get_image_wide_positional_embeddings())
        points = torch.zeros(1, 1, 1, 2)
        labels = -torch.ones(1, 1, 1, dtype=torch.int32)
        sparse, _ = tracker.prompt_encoder(input_points=points, input_labels=labels, input_boxes=None, input_masks=None)
        self.register_buffer("sparse", sparse)

    def forward(self, s0, s1, feat, dense):
        n = feat.shape[0]
        masks, iou, tokens, score = self.decoder(
            image_embeddings=feat,
            image_positional_embeddings=self.pos.repeat(n, 1, 1, 1),
            sparse_prompt_embeddings=self.sparse.repeat(n, 1, 1, 1),
            dense_prompt_embeddings=dense,
            multimask_output=True,
            high_resolution_features=[s0.repeat(n, 1, 1, 1), s1.repeat(n, 1, 1, 1)],
        )
        # masks [N,1,3,288,288], iou [N,1,3], tokens [N,1,3,256], score [N,1,1]
        best = torch.argmax(iou, dim=-1)
        low_res = torch.gather(masks, 2, best[:, :, None, None, None].expand(-1, -1, 1, MASK, MASK))[:, 0]
        token = torch.gather(tokens, 2, best[:, :, None, None].expand(-1, -1, 1, HIDDEN))[:, 0, 0]
        best_iou = torch.gather(iou, 2, best[:, :, None])[:, 0]
        appearing = score > 0
        low_res = torch.where(appearing[:, :, None], low_res, torch.full_like(low_res, -1024.0))
        pointer = self.pointer_proj(token)
        weight = appearing[:, 0].to(pointer.dtype)
        return low_res, best_iou, score, weight * pointer + (1 - weight) * self.no_pointer


class MemEnc(nn.Module):
    """_encode_new_memory, with `binarize` for its is_mask_from_pts branch."""

    def __init__(self, tracker):
        super().__init__()
        self.encoder = tracker.memory_encoder
        self.occlusion = tracker.occlusion_spatial_embedding_parameter

    def forward(self, f72, mask, score, binarize):
        high = resize(resize(mask, IMAGE), MEM_MASK)
        m = torch.where(binarize > 0.5, (high > 0).to(high.dtype), torch.sigmoid(high)) * 20.0 - 10.0
        x = self.encoder.feature_projection(f72) + self.encoder.mask_downsampler(m)
        x = self.encoder.projection(self.encoder.memory_fuser(x))
        appearing = (score > 0).to(x.dtype)
        return x + (1 - appearing[..., None]) * self.occlusion[..., None, None]


class AttnLayer(nn.Module):
    """One layer of Sam3TrackerVideoMemoryAttention, with spatial and pointer memory as separate inputs."""

    def __init__(self, tracker, vision_pos, index):
        super().__init__()
        memory = tracker.memory_attention
        self.index = index
        self.layer = memory.layers[index]
        self.rotary = memory.rotary_emb
        self.norm = memory.layer_norm
        self.register_buffer("position_ids", memory.position_ids.clone())
        # rotate_pairwise as a permutation and signs, which needs no shape arithmetic
        self.register_buffer("swap", torch.arange(HIDDEN).reshape(-1, 2).flip(-1).reshape(-1))
        self.register_buffer("signs", torch.tensor([-1.0, 1.0]).repeat(HIDDEN // 2))
        if index == 0:
            self.register_buffer("vision_pos", vision_pos)

    def rope(self, x, cos, sin):
        return x * cos + x[..., self.swap] * self.signs * sin

    def attend(self, q, k, v):
        # head_dim 256, one head: scaling is 256 ** -0.5
        return torch.softmax(q @ k.transpose(1, 2) / 16.0, dim=-1) @ v

    def forward(self, x, spatial, spatial_pos, pointer, pointer_pos):
        n = x.shape[0]
        if self.index == 0:
            x = x.flatten(2).transpose(1, 2) + 0.1 * self.vision_pos
        cos, sin = self.rotary(x, self.position_ids)
        blocks = spatial.shape[1] // TOKENS
        cos_k, sin_k = cos.repeat(1, blocks, 1), sin.repeat(1, blocks, 1)
        layer = self.layer

        a = layer.self_attn
        q = layer.layer_norm1(x)
        out = self.attend(self.rope(a.q_proj(q), cos, sin), self.rope(a.k_proj(q), cos, sin), a.v_proj(q))
        x = x + a.o_proj(out)

        a = layer.cross_attn_image
        q = self.rope(a.q_proj(layer.layer_norm2(x)), cos, sin)
        k_spatial = self.rope(a.k_proj(spatial + spatial_pos), cos_k, sin_k)
        k_pointer = a.k_proj(pointer + pointer_pos)
        out = self.attend(q, torch.cat([k_spatial, k_pointer], dim=1), a.v_proj(torch.cat([spatial, pointer], dim=1)))
        x = x + a.o_proj(out)

        x = x + layer.linear2(F.relu(layer.linear1(layer.layer_norm3(x))))
        if self.index == LAYERS - 1:
            return self.norm(x).transpose(1, 2).reshape(n, HIDDEN, GRID, GRID)
        return x


def to_seq(pos: torch.Tensor) -> torch.Tensor:
    """[1,C,72,72] to [5184,C]."""
    return pos.flatten(2).permute(2, 0, 1)[:, 0].clone()


def tables_graph(tracker, mem_pos: torch.Tensor) -> onnx.ModelProto:
    """The values the memory bank needs, as a graph with no inputs, so that every host can load them as a model."""
    values = {
        "mem_pos": mem_pos,  # [5184,64]
        "mem_tpos": tracker.memory_temporal_positional_encoding[:, 0, 0],  # [7,64]
        "tproj_w": tracker.temporal_positional_encoding_projection_layer.weight,  # [64,256]
        "tproj_b": tracker.temporal_positional_encoding_projection_layer.bias,  # [64]
        "no_mask": tracker.prompt_encoder.no_mask_embed.weight[0],  # [256]
    }
    arrays = {k: v.detach().numpy().astype(np.float32) for k, v in values.items()}
    graph = helper.make_graph(
        [helper.make_node("Identity", [f"{k}_value"], [k], name=k) for k in arrays],
        "tracker_tables",
        [],
        [helper.make_tensor_value_info(k, TensorProto.FLOAT, a.shape) for k, a in arrays.items()],
        [numpy_helper.from_array(a, f"{k}_value") for k, a in arrays.items()],
    )
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)], producer_name="eyespy")
    m.ir_version = 10
    return m


def export(module, inputs, names, outputs, dynamic, path: Path) -> None:
    print("exporting", path.name, flush=True)
    module.eval()
    torch.onnx.export(
        module,
        inputs,
        str(path),
        input_names=names,
        output_names=outputs,
        dynamic_shapes=tuple(dynamic.get(n) for n in names) if dynamic else None,
        opset_version=18,
        dynamo=True,
        external_data=False,
        optimize=True,
        verify=False,
    )
    m = strip(onnx.load(str(path)))
    onnx.checker.check_model(m)
    onnx.save(m, str(path))


def main(sam3_dir: str, out_dir: str) -> None:
    weights = Path(sam3_dir) / "model.safetensors"
    digest = hashlib.sha256(weights.read_bytes()).hexdigest()
    if digest != WEIGHTS_SHA256:
        sys.exit(f"{weights}: sha256 {digest}, expected {WEIGHTS_SHA256}")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    torch.set_grad_enabled(False)

    model, info = Sam3VideoModel.from_pretrained(sam3_dir, attn_implementation="eager", output_loading_info=True)
    model.eval()
    # A missing key would export freshly initialised, random weights.
    problems = {k: v for k, v in info.items() if k in ("missing_keys", "mismatched_keys") and v}
    if problems:
        sys.exit(f"the weights do not cover the model: {problems}")
    tracker = model.tracker_model
    neck = model.tracker_neck

    cpu = torch.device("cpu")
    vision_pos = to_seq(neck.position_encoding(torch.Size([1, HIDDEN, GRID, GRID]), cpu, torch.float32))
    mem_pos = to_seq(tracker.memory_encoder.position_encoding(torch.Size([1, MEM, GRID, GRID]), cpu, torch.float32))

    # Examples passed twice are clones, since the exporter merges two inputs given the same tensor object.
    n = torch.export.Dim.AUTO
    f72 =torch.zeros(1, HIDDEN, GRID, GRID)
    s0, s1 = torch.zeros(1, 32, MASK, MASK), torch.zeros(1, 64, MASK // 2, MASK // 2)
    mask = torch.zeros(1, 1, MASK, MASK)
    trunk = torch.zeros(1, 1024, GRID, GRID)
    export(Neck(model), (trunk,), ["trunk"], ["s0", "s1", "f72"], None, out / "neck_fp32.onnx")
    export(MaskEmbed(tracker), (mask,), ["mask"], ["dense"], {"mask": {0: n}}, out / "mask_embed_fp32.onnx")
    export(
        Decoder(tracker),
        (s0, s1, f72, f72.clone()),
        ["s0", "s1", "feat", "dense"],
        ["low_res", "iou", "score", "pointer"],
        {"feat": {0: n}, "dense": {0: n}},
        out / "decoder_fp32.onnx",
    )
    export(
        MemEnc(tracker),
        (f72, mask, torch.ones(1, 1, 1), torch.tensor(1.0)),
        ["f72", "mask", "score", "binarize"],
        ["mem"],
        {"mask": {0: n}, "score": {0: n}},
        out / "memenc_fp32.onnx",
    )
    spatial, pointer = torch.zeros(1, TOKENS * 2, MEM), torch.zeros(1, 8, MEM)
    memory_axes = {0: n, 1: n}
    for i in range(LAYERS):
        x = f72 if i == 0 else torch.zeros(1, TOKENS, HIDDEN)
        export(
            AttnLayer(tracker, vision_pos, i),
            (x, spatial, spatial.clone(), pointer, pointer.clone()),
            ["x", "spatial", "spatial_pos", "pointer", "pointer_pos"],
            ["y"],
            {
                "x": {0: n},
                "spatial": memory_axes,
                "spatial_pos": memory_axes,
                "pointer": memory_axes,
                "pointer_pos": memory_axes,
            },
            out / f"attn_l{i}_fp32.onnx",
        )
    tables = tables_graph(tracker, mem_pos)
    onnx.checker.check_model(tables, full_check=True)
    onnx.save(tables, str(out / "tables.onnx"))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python export_tracker.py SAM3_DIR OUT_DIR")
    main(*sys.argv[1:])
