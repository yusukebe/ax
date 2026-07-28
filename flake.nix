{
  description = "The AI-era curl: fetch, discover, extract. One command.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, bun2nix, ... }:
    let
      inherit (nixpkgs) lib;

      forAllSystems = lib.genAttrs (import ./nix/systems.nix);

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ax = pkgs.callPackage ./package.nix {
            bun2nix = bun2nix.packages.${system}.default;
          };
        in
        {
          inherit ax;
          default = ax;
        }
      );
    in
    {
      inherit packages;

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      # Building ax compiles the embedded JavaScript engine from source, which
      # costs minutes per system — `nix flake check` is not quick here.
      checks = forAllSystems (system: {
        build = packages.${system}.ax;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.bun
              bun2nix.packages.${system}.default
              # `bun run build` shells out to cmake and clang. On Darwin
              # clang comes from the Xcode toolchain — the nix wrapper does not
              # find the macOS SDK headers the embedded engine needs (zlib.h).
              pkgs.cmake
            ]
            ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.clang ];

            shellHook = ''
              # Install dependencies only if node_modules is missing or older
              # than the lockfile
              if [ ! -d node_modules ] || [ bun.lock -nt node_modules ]; then
                echo "📦 Installing dependencies..."
                bun install --frozen-lockfile
              fi
            '';
          };
        }
      );
    };
}
