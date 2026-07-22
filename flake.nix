{
  description = "The AI-era curl: fetch, discover, extract. One command.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, bun2nix, ... }:
    let
      inherit (nixpkgs) lib;

      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = lib.genAttrs systems;

      axFor = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun2nix' = bun2nix.packages.${system}.default;

          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          inherit (packageJson) version;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./bun.lock
              ./tsconfig.json
              ./src
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "ax";
          inherit version src;

          nativeBuildInputs = [ bun2nix'.hook ];

          bunDeps = bun2nix'.fetchBunDeps {
            bunNix = ./nix/bun.nix;
          };

          # The published bin is src/index.ts run under bun — no bundle step.
          dontUseBunBuild = true;
          # Same as the hook's per-platform defaults, plus --production to keep
          # devDependencies out of the runtime closure.
          bunInstallFlags = [ "--linker=isolated" "--production" ]
            ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ "--backend=symlink" ];
          # postinstall regenerates bun.nix, which is pointless (and fails) in
          # the sandbox.
          dontRunLifecycleScripts = true;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/ax $out/bin
            cp -r src node_modules package.json $out/share/ax/

            substituteInPlace $out/share/ax/src/index.ts \
              --replace-fail "#!/usr/bin/env bun" "#!${pkgs.bun}/bin/bun"
            chmod +x $out/share/ax/src/index.ts
            ln -s $out/share/ax/src/index.ts $out/bin/ax

            runHook postInstall
          '';

          doInstallCheck = true;
          installCheckPhase = ''
            $out/bin/ax --version | grep -Fxq "${version}"
          '';

          meta = {
            inherit (packageJson) description homepage;
            license = lib.getLicenseFromSpdxId packageJson.license;
            mainProgram = builtins.head (builtins.attrNames packageJson.bin);
          };
        };

      packages = forAllSystems (system: rec {
        ax = axFor system;
        default = ax;
      });
    in
    {
      inherit packages;

      apps = forAllSystems (system: rec {
        ax = {
          type = "app";
          program = lib.getExe packages.${system}.ax;
        };
        default = ax;
      });

      checks = forAllSystems (system: {
        build = packages.${system}.ax;
      });

      devShells = forAllSystems (system: {
        default = nixpkgs.legacyPackages.${system}.mkShellNoCC {
          packages = [
            nixpkgs.legacyPackages.${system}.bun
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
      });
    };
}
