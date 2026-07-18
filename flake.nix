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

        version = "0.1.18";

        assets = {
          "x86_64-linux" = {
            file = "ax-linux-x64";
            sha256 = "1383wnzylqb8fykwanx4y2kcr1a8rdfr1dcizmkaxql3vndvscw6";
          };
          "aarch64-linux" = {
            file = "ax-linux-arm64";
            sha256 = "08bp9bbxsqppwip9106jgdn3la8bxabxr3bp6yafld0z90pldz8w";
          };
          "x86_64-darwin" = {
            file = "ax-darwin-x64";
            sha256 = "1w5kx1ck06b73cvih75y0mxnmx92wh8b036pn7qgkq8p1fs3y4k9";
          };
          "aarch64-darwin" = {
            file = "ax-darwin-arm64";
            sha256 = "1qcbwdwb5f4wz7bfnwxbk4p3ymaaa14qwxv1gpwyjlfdrgspw3rn";
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
