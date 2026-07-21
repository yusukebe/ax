{
  description = "The AI-era curl: fetch, discover, extract. One command.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        version = "0.1.20";

        assets = {
          "x86_64-linux" = {
            file = "ax-linux-x64";
            sha256 = "13sz17rin0hbyn4yb9b65718jl4jb6n0x9lkhqff2x126057bsgp";
          };
          "aarch64-linux" = {
            file = "ax-linux-arm64";
            sha256 = "06r8b1p7bis7m2w81lhrvy4hg57l4bfnpks5km0fiiiibyy131kb";
          };
          "x86_64-darwin" = {
            file = "ax-darwin-x64";
            sha256 = "023k1pdb7n2klncgj38xab18xfl6xfm50r99jjvn5cidmzpdvkr0";
          };
          "aarch64-darwin" = {
            file = "ax-darwin-arm64";
            sha256 = "08d9lawiri781yfp3ki4bf5sq11r4a43mwygc728xyyw1cbl5mqp";
          };
        };

        asset = assets.${system} or (throw "Unsupported platform: ${system}");

        ax = pkgs.stdenv.mkDerivation {
          pname = "ax";
          inherit version;

          src = pkgs.fetchurl {
            url = "https://github.com/yusukebe/ax/releases/download/v${version}/${asset.file}";
            sha256 = asset.sha256;
          };

          dontUnpack = true;
          dontConfigure = true;
          dontBuild = true;

          nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.autoPatchelfHook
          ];

          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.stdenv.cc.cc.lib
            pkgs.stdenv.cc.libc
          ];

          installPhase = ''
            install -Dm755 $src $out/bin/ax
          '';

          meta = with pkgs.lib; {
            description = "The AI-era curl: fetch, discover, extract. One command.";
            homepage = "https://github.com/yusukebe/ax";
            downloadPage = "https://github.com/yusukebe/ax/releases";
            license = licenses.mit;
            mainProgram = "ax";
            platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
            sourceProvenance = [ sourceTypes.binaryNativeCode ];
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
