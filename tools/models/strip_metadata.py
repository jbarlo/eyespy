"""Drop the metadata and doc strings from an ONNX model, keeping everything the runtime uses.

The dynamo exporter writes provenance into `metadata_props`: each node's Python stack trace
(`pkg.torch.onnx.stack_trace`, with absolute paths to the export's source files and Python env,
e.g. /nix/store/..., C:\\Users\\...), its FX node, class hierarchy and name scopes, and
the optimizer's bookkeeping on values. None of it affects inference, and the paths depend on the
machine and directory the export ran in. This clears `metadata_props` and `doc_string` on the
model, every graph (subgraphs and functions included), node, attribute, value info and tensor.

It keeps the graph (nodes, names, attributes, order), initializers, inputs and outputs, value info
types and shapes, opset imports, IR version, and producer name and version (no paths).

The output depends only on the graph and weights, so the same export run from any directory
gives the same bytes.

Usage: python strip_metadata.py IN.onnx OUT.onnx   (OUT is a single file, weights inline)
"""

import sys

import onnx


def _clear(msg) -> None:
    # ClearField, not `= ""`, because ONNX is proto2, where assigning "" writes an explicit empty field
    msg.ClearField("doc_string")
    if "metadata_props" in msg.DESCRIPTOR.fields_by_name:
        msg.ClearField("metadata_props")


def _graph(g: onnx.GraphProto) -> None:
    _clear(g)
    for n in g.node:
        _node(n)
    for v in list(g.input) + list(g.output) + list(g.value_info) + list(g.initializer):
        _clear(v)
    for s in g.sparse_initializer:
        _clear(s.values)
        _clear(s.indices)


def _node(n: onnx.NodeProto) -> None:
    _clear(n)
    for a in n.attribute:
        _clear(a)
        if a.HasField("g"):
            _graph(a.g)
        for sub in a.graphs:
            _graph(sub)
        if a.HasField("t"):
            _clear(a.t)
        for t in a.tensors:
            _clear(t)


def strip(m: onnx.ModelProto) -> onnx.ModelProto:
    """Strip `m` in place and return it."""
    _clear(m)
    _graph(m.graph)
    for f in m.functions:
        _clear(f)
        for n in f.node:
            _node(n)
        for v in f.value_info:
            _clear(v)
    return m


def main(src: str, dst: str) -> None:
    m = strip(onnx.load(src))
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    print("stripped ->", dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python strip_metadata.py IN.onnx OUT.onnx")
    main(sys.argv[1], sys.argv[2])
