{
  lib,
  stdenv,
  nodejs_22,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  python3,
}:
let
  pnpm = pnpm_10.override { nodejs = nodejs_22; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "ungate-api";
  version = "0-unstable";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../apps/api
      ../apps/extension/package.json
      ../apps/web/package.json
      ../packages
      ../scripts/package.json
    ];
  };

  pnpmWorkspaces = [
    "@ungate/api"
    "@ungate/shared"
    "@ungate/dev-kit"
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 3;
    hash = "sha256-LfJlGZ1AmAZwIT4iAJSwzlsZ2afJzbNUsAHpWsdonoI=";
  };

  nativeBuildInputs = [
    nodejs_22
    pnpm
    pnpmConfigHook
    makeWrapper
    # better-sqlite3 compiles its native addon against this node.
    python3
  ];

  env.HUSKY = "0";

  buildPhase = ''
    runHook preBuild

    pushd apps/api/node_modules/better-sqlite3
    ${lib.getExe' nodejs_22 "npm"} run build-release --offline --nodedir=${nodejs_22}
    popd

    pnpm --filter @ungate/dev-kit run build
    pnpm --filter @ungate/shared run build
    pnpm --filter @ungate/api run build:bundle

    runHook postBuild
  '';

  # The same layout the extension ships in `bundled/api`: one bundle, migrations, and
  # better-sqlite3 with its runtime helpers.
  installPhase = ''
    runHook preInstall

    lib=$out/lib/ungate-api
    mkdir -p $lib/node_modules $out/bin
    cp -r apps/api/bundle apps/api/drizzle $lib/
    for dep in better-sqlite3 bindings file-uri-to-path; do
      cp -rL apps/api/node_modules/$dep $lib/node_modules/$dep 2>/dev/null \
        || cp -rL node_modules/.pnpm/node_modules/$dep $lib/node_modules/$dep
    done
    rm -rf $lib/node_modules/better-sqlite3/{deps,src,build/Release/obj*,build/Release/.deps}

    makeWrapper ${lib.getExe nodejs_22} $out/bin/ungate-api \
      --add-flags $lib/bundle/main.cjs \
      --set-default DRIZZLE_PATH $lib/drizzle \
      --set-default UNGATE_BETTER_SQLITE3_NATIVE_BINDING $lib/node_modules/better-sqlite3/build/Release/better_sqlite3.node

    runHook postInstall
  '';

  meta = {
    description = "ungate API server: Claude and ChatGPT account pool with usage per client";
    mainProgram = "ungate-api";
    platforms = lib.platforms.linux;
  };
})
