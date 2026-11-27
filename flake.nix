{
  description = "ungate: the API server as a package and a NixOS user service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (pkgs: {
        ungate-api = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.ungate-api;
      });

      devShells = forSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm_10
          ];
        };
      });

      nixosModules.default = import ./nix/module.nix self;

      checks = forSystems (pkgs: {
        ungate-api = self.packages.${pkgs.stdenv.hostPlatform.system}.ungate-api;
      });
    };
}
