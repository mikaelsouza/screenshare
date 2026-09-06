{
  description = "screenshare";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            # patchelf + glibc let scripts/patch-workerd.sh fix up the prebuilt
            # workerd binaries, which ship with an FHS loader NixOS lacks.
            pkgs.patchelf
            # Chromium for the end-to-end browser test. Playwright's own download
            # is a generic binary that will not run here, so the test drives the
            # Nix-built browser through playwright-core instead.
            pkgs.chromium
          ];

          NIX_GLIBC = pkgs.glibc;
          CHROMIUM_BIN = "${pkgs.chromium}/bin/chromium";
        };
      });
}
