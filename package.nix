{
  lib,
  stdenvNoCC,
  bun,
  versionCheckHook,
  # Not in nixpkgs — pass bun2nix.packages.${system}.default from the flake.
  bun2nix,
}:
let
  packageJson = lib.importJSON ./package.json;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./src
    ];
  };
in
stdenvNoCC.mkDerivation {
  pname = "ax";
  inherit (packageJson) version;
  inherit src;

  nativeBuildInputs = [ bun2nix.hook ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./nix/bun.nix;
  };

  # The published bin is src/index.ts run under bun — no bundle step.
  dontUseBunBuild = true;
  # Same as the hook's per-platform defaults, plus --production to keep
  # devDependencies out of the runtime closure.
  bunInstallFlags = [
    "--linker=isolated"
    "--production"
  ]
  ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin [ "--backend=symlink" ];
  # postinstall regenerates bun.nix, which is pointless (and fails) in
  # the sandbox.
  dontRunLifecycleScripts = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/ax $out/bin
    cp -r src node_modules package.json $out/share/ax/

    substituteInPlace $out/share/ax/src/index.ts \
      --replace-fail "#!/usr/bin/env bun" "#!${bun}/bin/bun"
    chmod +x $out/share/ax/src/index.ts
    ln -s $out/share/ax/src/index.ts $out/bin/ax

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ versionCheckHook ];

  meta = {
    inherit (packageJson) description homepage;
    license = lib.getLicenseFromSpdxId packageJson.license;
    mainProgram = builtins.head (builtins.attrNames packageJson.bin);
  };
}
