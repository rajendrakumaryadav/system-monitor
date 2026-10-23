#!/usr/bin/env bash
#
# Install / update / remove the System Monitor GNOME Shell extension.
#
# This script lives inside the extension directory and also works when called
# from the repository root:
#
#   ./install.sh              install and enable
#   ./install.sh --uninstall  disable and remove
#   ./install.sh --pack [DIR] build a .zip for extensions.gnome.org
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The script may live inside the extension directory (the usual case) or in a
# repository root that contains "system-monitor@<domain>". Support both.
DEFAULT_UUID="system-monitor@rajendrayadav.github.io"
if [ -f "$SCRIPT_DIR/metadata.json" ]; then
  SRC_DIR="$SCRIPT_DIR"
else
  SRC_DIR="$SCRIPT_DIR/$DEFAULT_UUID"
fi

if [ ! -f "$SRC_DIR/metadata.json" ]; then
  echo "error: extension source not found at $SRC_DIR" >&2
  exit 1
fi

# Read the UUID from metadata.json so the directory name and the install path
# can never drift apart.
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$SRC_DIR/metadata.json" | head -n1)"
UUID="${UUID:-$DEFAULT_UUID}"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST_DIR="$DATA_HOME/gnome-shell/extensions/$UUID"

# Files used only while developing the repository. They are not part of the
# installed extension and are stripped from the uploadable zip.
DEV_FILES=(install.sh .gitignore README.md TROUBLESHOOTING.md LICENSE)

STAGE_DIR=""
cleanup() {
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Install / update / remove the System Monitor GNOME Shell extension.

Usage:
  $(basename -- "$0") [--install]        install and enable (default)
  $(basename -- "$0") --uninstall        disable and remove
  $(basename -- "$0") --pack [DIR]       build a .zip for extensions.gnome.org
  $(basename -- "$0") --help             show this help

Environment:
  XDG_DATA_HOME   installation prefix (default: \$HOME/.local/share)
  OUT_DIR         output directory for --pack (default: parent of $UUID)
EOF
}

require_source() {
  for file in metadata.json extension.js prefs.js; do
    if [ ! -f "$SRC_DIR/$file" ]; then
      echo "error: missing $SRC_DIR/$file" >&2
      exit 1
    fi
  done
  if [ ! -d "$SRC_DIR/schemas" ]; then
    echo "error: missing schema directory $SRC_DIR/schemas" >&2
    exit 1
  fi
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required but was not found in PATH" >&2
    exit 1
  fi
}

install_extension() {
  require_source
  require_tool glib-compile-schemas

  echo "Installing $UUID"
  echo "  from: $SRC_DIR"
  echo "  to:   $DEST_DIR"

  rm -rf "$DEST_DIR"
  mkdir -p "$DEST_DIR"
  cp -r "$SRC_DIR"/. "$DEST_DIR"/

  # Never install build artefacts or development-only files.
  rm -f "$DEST_DIR/schemas/gschemas.compiled"
  for file in "${DEV_FILES[@]}"; do
    rm -f "$DEST_DIR/$file"
  done

  glib-compile-schemas "$DEST_DIR/schemas"

  if command -v gnome-extensions >/dev/null 2>&1; then
    if ! gnome-extensions enable "$UUID" 2>/dev/null; then
      echo "warning: could not enable the extension automatically." >&2
      echo "         Enable it from the Extensions app or run:" >&2
      echo "         gnome-extensions enable $UUID" >&2
    fi
  else
    echo "warning: 'gnome-extensions' not found; enable the extension manually." >&2
  fi

  echo
  echo "Done."
  echo "  X11:     press Alt+F2, type 'r', press Enter."
  echo "  Wayland: log out and log back in."
  echo "  Then check: gnome-extensions info $UUID"
}

uninstall_extension() {
  # Refuse to delete anything that is not the expected extension directory.
  case "$DEST_DIR" in
    */gnome-shell/extensions/"$UUID") ;;
    *)
      echo "error: refusing to remove unexpected path '$DEST_DIR'" >&2
      exit 1
      ;;
  esac

  if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
  fi
  rm -rf "$DEST_DIR"
  echo "Removed $DEST_DIR"
  echo "Settings were left in place. To reset them too:"
  echo "  gsettings reset-recursively org.gnome.shell.extensions.system-monitor"
}

pack_extension() {
  require_source
  require_tool gnome-extensions

  local out_dir="${1:-${OUT_DIR:-$(dirname -- "$SRC_DIR")}}"
  mkdir -p "$out_dir"
  out_dir="$(cd -- "$out_dir" && pwd)"

  # Stage a clean copy so local build artefacts never end up in the zip.
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/$UUID.XXXXXX")"
  cp -r "$SRC_DIR"/. "$STAGE_DIR"/
  rm -f "$STAGE_DIR/schemas/gschemas.compiled"
  rm -f "$STAGE_DIR"/*.shell-extension.zip
  for file in "${DEV_FILES[@]}"; do
    rm -f "$STAGE_DIR/$file"
  done

  local extra_sources=()
  if [ -d "$STAGE_DIR/icons" ]; then
    extra_sources+=(--extra-source=icons)
  fi

  rm -f "$out_dir/$UUID.shell-extension.zip"
  gnome-extensions pack "$STAGE_DIR" \
    ${extra_sources[@]+"${extra_sources[@]}"} \
    --out-dir="$out_dir" \
    --force

  echo "Created $out_dir/$UUID.shell-extension.zip"
}

case "${1:-}" in
  ""|--install|install)
    install_extension
    ;;
  --uninstall|--remove|uninstall)
    uninstall_extension
    ;;
  --pack|pack)
    pack_extension "${2:-}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "error: unknown option '$1'" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
