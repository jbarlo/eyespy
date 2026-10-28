"""Rewrite every ONNX `Sign` node as `Cast(x > 0) - Cast(x < 0)`.

ONNX Runtime's WebGPU execution provider has no `Sign` kernel, so each Sign node (in the SAM 3
detector, from the box relative-position bias in each decoder layer) falls back to the CPU, with a
copy from GPU to CPU and back around it. The replacement uses Greater, Less, Cast and Sub, which all
run on WebGPU. It gives -1, 0 or 1 exactly as Sign does for every input except NaN, which gives 0.
The detector's Sign inputs are coordinate differences, so that doesn't matter. The patched
detector's outputs are bit-identical to the original's on ONNX Runtime's CPU provider.

Usage: python patch_sign.py IN.onnx OUT.onnx

It loads external data, so OUT is a single self-contained file. The graph must stay under protobuf's
2 GB limit, as both detectors do.
"""

import sys

import onnx
from onnx import TensorProto, helper


def main(src: str, dst: str) -> None:
    m = onnx.load(src)
    m = onnx.shape_inference.infer_shapes(m)
    values = list(m.graph.value_info) + list(m.graph.input) + list(m.graph.output)
    types = {v.name: v.type.tensor_type.elem_type for v in values}
    types.update({i.name: i.data_type for i in m.graph.initializer})

    new = []
    replaced = 0
    for n in m.graph.node:
        if n.op_type != "Sign":
            new.append(n)
            continue
        x, y = n.input[0], n.output[0]
        t = types.get(x, TensorProto.FLOAT)
        p = n.name
        z = f"{p}_zero"
        new += [
            helper.make_node("Constant", [], [z], value=helper.make_tensor(z, t, [], [0.0])),
            helper.make_node("Greater", [x, z], [f"{p}_gt"]),
            helper.make_node("Less", [x, z], [f"{p}_lt"]),
            helper.make_node("Cast", [f"{p}_gt"], [f"{p}_gtf"], to=t),
            helper.make_node("Cast", [f"{p}_lt"], [f"{p}_ltf"], to=t),
            helper.make_node("Sub", [f"{p}_gtf", f"{p}_ltf"], [y]),
        ]
        replaced += 1

    del m.graph.node[:]
    m.graph.node.extend(new)
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    print("replaced", replaced, "Sign nodes ->", dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python patch_sign.py IN.onnx OUT.onnx")
    main(sys.argv[1], sys.argv[2])
