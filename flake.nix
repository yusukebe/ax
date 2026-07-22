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
          ax = nixpkgs.legacyPackages.${system}.callPackage ./package.nix {
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
            ];

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
