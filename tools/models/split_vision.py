"""Split Card Anvil's vision_fp16.onnx into parts that run one after another, without re-exporting anything.

One whole vision run stalls the GPU for too long, so each part holds one ViT block (or a few, with BLOCK_ENDS) and the
page can answer between parts. The parts' nodes and weights are the original graph's, with their original names:

- part_00 reads `pixel_values`. Each later part reads the output of the part before it, fp16 [1,72,72,1024].
- The last part's only output is the trunk, `permute_58`, fp16 [1,1024,72,72], which is what the tracker reads.
- `neck` reads the trunk and gives the detector's `features_288`, `features_144` and `features_72`. A frame that is only
  tracked never runs it.

Usage: python split_vision.py vision_fp16.onnx OUT_DIR [BLOCK_ENDS]
BLOCK_ENDS is a comma-separated list of the last block of each part, ending in 31. The default is one block per part.

Writes OUT_DIR/part_NN.onnx and OUT_DIR/neck.onnx.
"""

import hashlib
import re
import sys
from pathlib import Path

import onnx
from onnx import TensorProto, helper

# onnx/vision_fp16.onnx in CardAnvilModels/sam3-ONNX at 7eee2d79268e794e433b6e49467c5340525ac228
VISION_SHA256 = "02e1573a208a702dfbed03349fcbcf0b9bc228ee1ce24a6809b871f0cb1564fa"
BLOCKS = 32
PIXELS = "pixel_values"
TRUNK = "permute_58"
BLOCK_SHAPE = [1, 72, 72, 1024]
TRUNK_SHAPE = [1, 1024, 72, 72]
FEATURES = {"features_288": 288, "features_144": 144, "features_72": 72}
F32, F16 = TensorProto.FLOAT, TensorProto.FLOAT16
FC2_BIAS = re.compile(r"backbone\.layers\.(\d+)\.mlp\.fc2\.bias")


def block_outputs(nodes: list[onnx.NodeProto]) -> dict[int, str]:
    """Each block's residual output: the Add that follows the Add of its mlp's last bias."""
    out = {}
    for k, n in enumerate(nodes):
        for i in n.input:
            found = FC2_BIAS.search(i)
            if found:
                after = [a for a in nodes[k + 1 : k + 4] if n.output[0] in a.input and a.op_type == "Add"]
                if not after:
                    sys.exit(f"block {found.group(1)}: no residual Add after {n.name}")
                out[int(found.group(1))] = after[0].output[0]
    if sorted(out) != list(range(BLOCKS)):
        sys.exit(f"found blocks {sorted(out)}, expected 0 to {BLOCKS - 1}")
    return out


class Splitter:
    def __init__(self, m: onnx.ModelProto):
        self.m = m
        self.nodes = list(m.graph.node)
        self.stored = {t.name: t for t in m.graph.initializer}
        self.producer = {o: n for n in self.nodes for o in n.output}
        self.position = {id(n): k for k, n in enumerate(self.nodes)}

    def write(self, path: Path, inputs: dict[str, tuple], outputs: dict[str, tuple]) -> None:
        """A graph of what `outputs` need from `inputs`. It stops if they need anything else."""
        picked: dict[int, onnx.NodeProto] = {}
        reached: set[str] = set()
        seen: set[str] = set()
        stack = list(outputs)
        while stack:
            v = stack.pop()
            if v in seen or not v or v in self.stored:
                continue
            seen.add(v)
            if v in inputs or v not in self.producer:
                reached.add(v)
                continue
            n = self.producer[v]
            picked[id(n)] = n
            stack.extend(n.input)
        if reached != set(inputs):
            sys.exit(f"{path.name}: reads {sorted(reached)}, expected {sorted(inputs)}")
        nodes = sorted(picked.values(), key=lambda n: self.position[id(n)])
        used = {i for n in nodes for i in n.input}
        graph = helper.make_graph(
            nodes,
            "part",
            [helper.make_tensor_value_info(k, *v) for k, v in inputs.items()],
            [helper.make_tensor_value_info(k, *v) for k, v in outputs.items()],
            initializer=[self.stored[k] for k in sorted(used) if k in self.stored],
        )
        onnx.save(helper.make_model(graph, opset_imports=self.m.opset_import, ir_version=self.m.ir_version), str(path))


def main(src: str, out_dir: str, ends_arg: str | None = None) -> None:
    digest = hashlib.sha256(Path(src).read_bytes()).hexdigest()
    if digest != VISION_SHA256:
        sys.exit(f"{src}: sha256 {digest}, expected {VISION_SHA256}")
    ends = [int(x) for x in ends_arg.split(",")] if ends_arg else list(range(BLOCKS))
    if ends != sorted(set(ends)) or ends[-1] != BLOCKS - 1:
        sys.exit(f"BLOCK_ENDS must rise and end in {BLOCKS - 1}: {ends}")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    s = Splitter(onnx.load(src))
    blocks = block_outputs(s.nodes)
    last_input: dict[str, tuple] = {PIXELS: (F32, [1, 3, 1008, 1008])}
    for k, end in enumerate(ends):
        name = TRUNK if end == BLOCKS - 1 else blocks[end]
        output = (F16, TRUNK_SHAPE if name == TRUNK else BLOCK_SHAPE)
        s.write(out / f"part_{k:02d}.onnx", last_input, {name: output})
        last_input = {name: output}
    s.write(out / "neck.onnx", {TRUNK: (F16, TRUNK_SHAPE)}, {f: (F32, [1, 256, n, n]) for f, n in FEATURES.items()})
    print(f"{len(ends)} parts and the neck ->", out)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("usage: python split_vision.py vision_fp16.onnx OUT_DIR [BLOCK_ENDS]")
    main(*sys.argv[1:])
