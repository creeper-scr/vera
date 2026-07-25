{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsForSystem =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
    in
    {
      formatter = forAllSystems (system: (pkgsForSystem system).nixfmt-tree);

      # Desktop Electron Nix package was removed with stage-tamagotchi.
      # The stub in nix/package.nix fails loudly if evaluated.
      packages = forAllSystems (
        system:
        { default = self.packages.${system}.vera; } // self.overlays.vera (pkgsForSystem system) null
      );

      overlays = {
        default = self.overlays.vera;
        vera = final: _: {
          vera = final.callPackage ./nix/package.nix { };
        };
      };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsForSystem system;
        in
        with pkgs;
        {
          default = mkShell {
            packages = [
              nixd
              nixfmt
              nixfmt-tree
              nodejs_24
              pnpm
              python314
            ];
          };
        }
      );
    };
}
