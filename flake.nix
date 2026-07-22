{
  description = "The AI-era curl: fetch, discover, extract. One command.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

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

        # Production deps only: no devDependencies means no platform-specific
        # optional binaries (e.g. oxfmt), so this is identical across systems.
        bunDeps = pkgs.stdenvNoCC.mkDerivation {
          pname = "ax-bun-deps";
          inherit version src;

          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;

          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            bun install --frozen-lockfile --production --ignore-scripts
            runHook postBuild
          '';

          installPhase = ''
            mkdir -p $out
            cp -r node_modules $out/node_modules
          '';

          outputHashMode = "recursive";
          outputHash = "sha256-EX6ItcE7zlM71JTbFsavuiRMFa1KS1svcaKwzQL6ZjI=";
        };

        ax = pkgs.stdenvNoCC.mkDerivation {
          pname = "ax";
          inherit version src;

          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            mkdir -p $out/share/ax $out/bin
            cp -r src $out/share/ax/src
            cp package.json $out/share/ax/package.json
            cp -r ${bunDeps}/node_modules $out/share/ax/node_modules
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ax \
              --add-flags "run $out/share/ax/src/index.ts"
          '';

          doInstallCheck = true;
          installCheckPhase = ''
            $out/bin/ax --version | grep -Fxq "${version}"
          '';

          meta = with pkgs.lib; {
            description = "The AI-era curl: fetch, discover, extract. One command.";
            homepage = "https://github.com/yusukebe/ax";
            downloadPage = "https://github.com/yusukebe/ax/releases";
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
