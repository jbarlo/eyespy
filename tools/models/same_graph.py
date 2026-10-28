"""Check that two ONNX files hold the same model, ignoring metadata.

This strips both models with strip_metadata.strip and compares the rest byte for byte (graph, node
names, attributes, initializer values).

Usage: python same_graph.py A.onnx B.onnx   (exit 0 if the same, 1 if not)
"""

import sys

import onnx

from strip_metadata import strip


def canonical(path: str) -> bytes:
    return strip(onnx.load(path)).SerializeToString()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python same_graph.py A.onnx B.onnx")
    same = canonical(sys.argv[1]) == canonical(sys.argv[2])
    print("same graph" if same else "DIFFERENT")
    sys.exit(0 if same else 1)
