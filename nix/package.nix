{
  stdenvNoCC,
  lib,
}:

# Desktop Electron packaging was removed with apps/stage-tamagotchi.
# Keep a stub so existing flake consumers fail loudly instead of building a missing app.
stdenvNoCC.mkDerivation {
  pname = "vera";
  version = "0.11.3";

  dontUnpack = true;

  buildPhase = ''
    echo "Nix Electron packaging for Vera desktop was removed." >&2
    echo "Use stage-web via pnpm (pnpm install && pnpm dev)." >&2
    exit 1
  '';

  meta = {
    description = "Project Vera (desktop Nix package removed; use stage-web)";
    homepage = "https://github.com/moeru-ai/airi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
    mainProgram = "vera";
  };
}
