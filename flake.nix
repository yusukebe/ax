{
  description = "The AI-era curl: fetch, discover, extract. One command.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, bun2nix, ... }:
    # bun2nix only ships for these systems; notably x86_64-darwin is out
    # (nixpkgs 26.05 is its last supported release anyway).
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        bun2nix' = bun2nix.packages.${system}.default;

        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./bun.lock
            ./tsconfig.json
            ./src
          ];
        };

        ax = bun2nix'.writeBunApplication {
          pname = "ax";
          inherit version src;

          bunDeps = bun2nix'.fetchBunDeps {
            bunNix = ./nix/bun.nix;
          };

          # The published bin is src/index.ts run under bun — no bundle step.
          dontUseBunBuild = true;
          dontUseBunCheck = true;
          # Same as the hook's per-platform defaults, plus --production to keep
          # devDependencies out of the runtime closure.
          bunInstallFlags = [ "--linker=isolated" "--production" ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ "--backend=symlink" ];
          # postinstall regenerates bun.nix, which is pointless (and fails) in
          # the sandbox.
          dontRunLifecycleScripts = true;

          startScript = ''
            bun run src/index.ts "$@"
          '';

          meta = with pkgs.lib; {
            description = "The AI-era curl: fetch, discover, extract. One command.";
            homepage = "https://github.com/yusukebe/ax";
            license = licenses.mit;
            mainProgram = "ax";
          };
        };
      in
      {
        packages = {
          ax = ax;
          default = ax;
        };

        apps = {
          ax = {
            type = "app";
            program = "${ax}/bin/ax";
          };
          default = {
            type = "app";
            program = "${ax}/bin/ax";
          };
        };

        checks = {
          build = ax;
        };
      }
    );
}
