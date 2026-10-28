{
  description = "eyespy: find and catalogue the objects in a video, locally in your browser";

  # Pinned to the locked rev so `nix flake update` can't move the Python env, which gets torch from the cache.
  inputs.nixpkgs.url = "github:nixos/nixpkgs/b1b875982b17dabde9b4a37f3e229e74913e6db3";
  # Node and the Vulkan loader for the TypeScript server (onnxruntime-node, WebGPU EP through Dawn). Pinned apart
  # from `nixpkgs` because Dawn dlopens the system Mesa driver (/run/opengl-driver), which needs a glibc at least as
  # new as the host's. The Python env stays on the older lock so torch keeps coming from the cache.
  inputs.nixpkgs-gpu.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, nixpkgs-gpu, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      gpu = nixpkgs-gpu.legacyPackages.${system};
      node = gpu.nodejs_22;
      # for the detector export
      python = pkgs.python3.withPackages (ps: with ps; [
        torch # CPU
        torchvision # transformers' Sam3Model requires it
        transformers # Sam3Model
        huggingface-hub # `hf download` for the gated SAM 3 weights
        pillow
        numpy
      ]);
      # The CLI runs from its esbuild bundle. The wrapper rebuilds the bundle when it is missing or older than its
      # sources, and runs the sources with tsx if that build fails.
      eyespy = pkgs.writeShellScriptBin "eyespy" ''
        root=''${EYESPY_ROOT:?run from the eyespy devshell}
        export EYESPY_SERVER=''${EYESPY_SERVER:-${eyespy-server}/bin/eyespy-server}
        bundle=$root/cli/dist/eyespy.mjs
        if [ ! -e "$bundle" ] || [ -n "$(${pkgs.findutils}/bin/find "$root/cli/src" "$root/cli/scripts" "$root/core/src" \
            "$root/cli/package.json" "$root/pnpm-lock.yaml" -newer "$bundle" -print -quit 2>/dev/null)" ]; then
          ${node}/bin/node --import "$root/cli/tsx.mjs" "$root/cli/scripts/bundle.ts" >/dev/null 2>&1 ||
            exec ${node}/bin/node --import "$root/cli/tsx.mjs" "$root/cli/src/main.ts" "$@"
        fi
        export NODE_COMPILE_CACHE=''${XDG_CACHE_HOME:-$HOME/.cache}/eyespy-node
        exec ${node}/bin/node "$bundle" "$@"
      '';
      # The session server. Only this process gets LD_LIBRARY_PATH, because the shell itself must not have it.
      eyespy-server = pkgs.writeShellScriptBin "eyespy-server" ''
        root=''${EYESPY_ROOT:?run from the eyespy devshell}
        export LD_LIBRARY_PATH=${gpu.vulkan-loader}/lib
        exec ${node}/bin/node --import "$root/server/tsx.mjs" "$root/server/src/main.ts" "$@"
      '';
      shell = pkgs.mkShell {
        packages = [
          python
          # validation scripts extract frames with it, but eyespy itself doesn't run it
          pkgs.ffmpeg
          pkgs.graphviz # `pnpm deps:graph` (dot to svg)
          node
          gpu.pnpm
          # web/ checks drive it headless with WebGPU. It comes from the GPU
          # nixpkgs because its Dawn loads the host's Mesa Vulkan driver too. Its own wrapper finds the loader
          # without LD_LIBRARY_PATH.
          gpu.chromium
          eyespy
          eyespy-server
        ];
        # a host LD_LIBRARY_PATH can carry libraries built against another glibc
        shellHook = ''
          unset LD_LIBRARY_PATH
          export EYESPY_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
          export EYESPY_VK_LIB=${gpu.vulkan-loader}/lib # GPU scripts: LD_LIBRARY_PATH=$EYESPY_VK_LIB node ...
        '';
      };
    in
    {
      devShells.${system}.default = shell;
    };
}
