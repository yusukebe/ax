{
  lib,
  clangStdenv,
  bun,
  cmake,
  nodejs,
  zlib,
  curl,
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
      ./tsconfig.json
      ./src
      ./scripts/build-scriptc.ts
      ./scripts/gen-agent-context.ts
    ];
  };
in
# clangStdenv (not stdenvNoCC): ax compiles to a native executable with
# scriptc, which invokes `clang` by name — the default Linux stdenv provides
# gcc and no clang, and the build fails with `spawn clang ENOENT`. --dynamic
# additionally builds the embedded JavaScript engine from the vendored sources
# in node_modules/@scriptc/runtime with CMake. Everything it compiles is
# vendored, so the build stays offline.
clangStdenv.mkDerivation {
  pname = packageJson.name;
  inherit (packageJson) version;
  inherit src;

  nativeBuildInputs = [
    bun2nix.hook
    bun
    # scriptc's CLI runs on Node, not Bun: typescript@7's synchronous RPC
    # channel reads `stdout._handle.fd` off a spawned child, which Bun does not
    # expose. Its own package.json asks for node >= 20.
    nodejs
    cmake
  ];

  # The generated C links the HOST's zlib and libcurl (the vendored copies under
  # @scriptc/runtime serve the cross-compile path only), so under nix's stdenv
  # they have to be real inputs rather than SDK-implicit ones.
  buildInputs = [
    zlib
    curl
  ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./nix/bun.nix;
  };

  # The compiler ships as a devDependency, so --production would drop it.
  dontUseBunBuild = true;
  bunInstallFlags = [
    "--linker=isolated"
  ]
  ++ lib.optionals clangStdenv.hostPlatform.isDarwin [ "--backend=symlink" ];
  # postinstall regenerates bun.nix, which is pointless (and fails) in
  # the sandbox.
  dontRunLifecycleScripts = true;

  # cmake's setup hook would otherwise try to configure the source root, which
  # has no CMakeLists.txt — scriptc invokes cmake itself.
  dontUseCmakeConfigure = true;

  buildPhase = ''
    runHook preBuild
    bun run scripts/build-scriptc.ts ax
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 ax $out/bin/ax
    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ versionCheckHook ];

  meta = {
    inherit (packageJson) description homepage;
    license = lib.getLicenseFromSpdxId packageJson.license;
    mainProgram = "ax";
    platforms = import ./nix/systems.nix;
  };
}
