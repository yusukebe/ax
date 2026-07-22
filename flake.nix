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

        version = "0.1.21";

        assets = {
          "x86_64-linux" = {
            file = "ax-linux-x64";
            sha256 = "09gnggg14lc5ximyn6rs9djns0lp5d2d1xaxagq277x5ikapjb3w";
          };
          "aarch64-linux" = {
            file = "ax-linux-arm64";
            sha256 = "063jizgymp3sd86sixjd44rjqyv0yhqrbrwsi768djcsky5y6f09";
          };
          "x86_64-darwin" = {
            file = "ax-darwin-x64";
            sha256 = "17lrx38b45y3j1885pq6w60p98kznrmh6rngvgn8r16pcm7mw8si";
          };
          "aarch64-darwin" = {
            file = "ax-darwin-arm64";
            sha256 = "19wgw4sa16bp458y6hf9qv233596ys1fws91kjybi5mwq7sdfckj";
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
          dontStrip = true;

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
