#!/usr/bin/env bash
# Runs a TS script with the Vulkan loader the WebGPU EP needs, in the devshell. Usage: gpu.sh <script.ts> [args...]
# Models default to the main checkout's models, also from a worktree.
here=$(cd "$(dirname "$0")/../.." && pwd)
common=$(git -C "${EYESPY_ROOT:-$here}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
root=${common:+$(dirname "$common")}
export EYESPY_MODELS=${EYESPY_MODELS:-${root:-${EYESPY_ROOT:-$here/..}}/models/onnx}
LD_LIBRARY_PATH=${EYESPY_VK_LIB:?run inside nix develop} exec node --import "$here/tsx.mjs" "$@"
