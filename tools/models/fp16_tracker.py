"""Convert a tracker graph to fp16 inside, keeping float32 at its inputs and outputs.

Stored weights are rounded to fp16, every Cast to float32 becomes a Cast to fp16, and each float32 input and output
gets a Cast. Nodes that depend on no input stay in float32, because they make tables at load time (the attention
layers' rotary tables) and fp16 angles would be wrong. Their results get a Cast where the fp16 part reads them.
Inputs named as FP16_INPUT take fp16 directly, with no Cast: the neck's trunk, which comes out of the vision graph as
fp16, so that its GPU buffer can go straight in.

It refuses what it doesn't know how to convert: a Constant node, a float tensor attribute, a float Resize roi or scales.

Usage: python fp16_tracker.py IN.onnx OUT.onnx [FP16_INPUT...]
"""

import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

F32, F16 = TensorProto.FLOAT, TensorProto.FLOAT16
# fp16's largest finite value
LIMIT = 65504.0


def rounded(t: onnx.TensorProto, name: str) -> onnx.TensorProto:
    a = numpy_helper.to_array(t).astype(np.float32)
    return numpy_helper.from_array(np.clip(a, -LIMIT, LIMIT).astype(np.float16), name)


def table_nodes(g: onnx.GraphProto) -> set[int]:
    """Indices of the nodes that depend on no graph input. An exported graph is topologically sorted."""
    known = {t.name for t in g.initializer} | {""}
    out = set()
    for k, n in enumerate(g.node):
        if all(i in known for i in n.input):
            out.add(k)
            known.update(n.output)
    return out


def check(n: onnx.NodeProto, types: dict[str, int]) -> None:
    if n.op_type == "Constant":
        sys.exit(f"{n.name}: Constant node, expected initializers")
    if any(a.HasField("t") and a.t.data_type == F32 for a in n.attribute):
        sys.exit(f"{n.name}: float tensor attribute on {n.op_type}")
    if n.op_type == "Resize" and any(i and types.get(i) == F32 for i in n.input[1:3]):
        sys.exit(f"{n.name}: float Resize roi or scales")


def convert(m: onnx.ModelProto, fp16_inputs: list[str]) -> onnx.ModelProto:
    g = m.graph
    for i in g.input:
        if i.name in fp16_inputs:
            i.type.tensor_type.elem_type = F16
    types = {v.name: v.type.tensor_type.elem_type for v in onnx.shape_inference.infer_shapes(m).graph.value_info}
    types.update({t.name: t.data_type for t in g.initializer})
    types.update({v.name: v.type.tensor_type.elem_type for v in list(g.input) + list(g.output)})
    tables = table_nodes(g)
    stored = {t.name: t for t in g.initializer}
    read_by_tables = {i for k in tables for i in g.node[k].input}
    outputs = {o.name for o in g.output if types[o.name] == F32}

    keep = [t for t in g.initializer if t.data_type != F32 or t.name in read_by_tables]
    swapped: dict[str, str] = {}
    copies: list[onnx.TensorProto] = []
    nodes: list[onnx.NodeProto] = []
    tail: list[onnx.NodeProto] = []

    def fp16_of(v: str) -> str:
        """The fp16 value that the converted nodes read in place of float32 value `v`."""
        if v in swapped:
            return swapped[v]
        if v in stored:
            name = f"{v}__f16" if v in read_by_tables else v
            copies.append(rounded(stored[v], name))
        else:
            name = f"{v}__f16"
            nodes.append(helper.make_node("Cast", [v], [name], to=F16, name=f"cast_{v}"))
        swapped[v] = name
        return name

    for k, n in enumerate(g.node):
        check(n, types)
        if k in tables:
            nodes.append(n)
            continue
        for a in n.attribute:
            if a.name == "to" and a.i == F32:
                a.i = F16
        for j, i in enumerate(n.input):
            if i and types.get(i) == F32:
                n.input[j] = fp16_of(i)
        for j, o in enumerate(n.output):
            if o in outputs:
                swapped[o] = n.output[j] = f"{o}__f16"
                tail.append(helper.make_node("Cast", [swapped[o]], [o], to=F32, name=f"cast_out_{o}"))
        nodes.append(n)

    del g.node[:]
    g.node.extend(nodes + tail)
    del g.initializer[:]
    used = {i for n in g.node for i in n.input}
    g.initializer.extend(t for t in keep + copies if t.name in used)
    del g.value_info[:]
    return m


def main(src: str, dst: str, *fp16_inputs: str) -> None:
    m = convert(onnx.load(src), list(fp16_inputs))
    onnx.checker.check_model(m, full_check=True)
    onnx.save(m, dst)
    print("fp16 ->", dst)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: python fp16_tracker.py IN.onnx OUT.onnx [FP16_INPUT...]")
    main(*sys.argv[1:])
