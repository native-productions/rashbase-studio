#!/usr/bin/env bash
#
# Rashbase Studio installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/native-productions/rashbase-studio/main/scripts/install.sh | bash
#
# Downloads the matching artifact from the latest GitHub release and installs
# it. Set RASHBASE_VERSION=v0.1.0 to pin a specific release.

set -euo pipefail

REPO="${RASHBASE_REPO:-native-productions/rashbase-studio}"
VERSION="${RASHBASE_VERSION:-latest}"
APP_NAME="Rashbase Studio"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
need curl

# --- pick the artifact suffix for this platform -----------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64) suffix="aarch64.dmg" ;;
      x86_64) suffix="x64.dmg" ;;
      *) die "unsupported macOS architecture: $arch" ;;
    esac
    ;;
  Linux)
    [ "$arch" = "x86_64" ] || die "unsupported Linux architecture: $arch (only x86_64 is published)"
    # .deb where dpkg exists, .rpm where rpm does, AppImage as the portable
    # fallback that needs neither.
    if command -v dpkg >/dev/null 2>&1; then
      suffix="amd64.deb"
    elif command -v rpm >/dev/null 2>&1; then
      suffix="x86_64.rpm"
    else
      suffix="amd64.AppImage"
    fi
    ;;
  *)
    die "unsupported OS: $os (Windows users: use scripts/install.ps1)"
    ;;
esac

# --- resolve the download URL ----------------------------------------------

if [ "$VERSION" = "latest" ]; then
  api="https://api.github.com/repos/$REPO/releases/latest"
else
  api="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi

info "Looking up $VERSION release of $REPO"
# A draft release is invisible to this endpoint, so a 404 here usually means
# the release exists but has not been published yet.
release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
  ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$api")" \
  || die "no published $VERSION release for $REPO (drafts do not count), or the GitHub API is unreachable"

# Asset names contain spaces, so read the already-encoded browser_download_url
# rather than reconstructing it from the version and product name.
url="$(printf '%s' "$release_json" \
  | sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' \
  | grep -i -- "$suffix\$" | head -n 1 || true)"

[ -n "$url" ] || die "no $suffix artifact in the $VERSION release of $REPO"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
file="$tmp/${url##*/}"

info "Downloading ${url##*/}"
curl -fL --progress-bar -o "$file" "$url"

# --- install ----------------------------------------------------------------

case "$suffix" in
  *.dmg)
    info "Mounting the disk image"
    mount_point="$(hdiutil attach -nobrowse -readonly "$file" \
      | grep -o '/Volumes/.*' | head -n 1)"
    [ -n "$mount_point" ] || die "could not mount $file"
    trap 'hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

    target="/Applications/$APP_NAME.app"
    if [ -w /Applications ]; then sudo=""; else sudo="sudo"; fi

    info "Installing to $target"
    $sudo rm -rf "$target"
    $sudo cp -R "$mount_point/$APP_NAME.app" "$target"
    hdiutil detach "$mount_point" -quiet

    # Releases are not notarized yet, so macOS would otherwise refuse to open
    # the app on first launch.
    $sudo xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

    info "Installed. Launch it with: open -a \"$APP_NAME\""
    ;;

  *.deb)
    info "Installing with apt"
    sudo apt-get install -y "$file"
    info "Installed. Launch it with: rashbase-studio"
    ;;

  *.rpm)
    info "Installing with rpm"
    if command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y "$file"
    else
      sudo rpm -Uvh "$file"
    fi
    info "Installed. Launch it with: rashbase-studio"
    ;;

  *.AppImage)
    bindir="${RASHBASE_BIN_DIR:-$HOME/.local/bin}"
    mkdir -p "$bindir"
    install -m 755 "$file" "$bindir/rashbase-studio"
    info "Installed to $bindir/rashbase-studio"
    case ":$PATH:" in
      *":$bindir:"*) info "Launch it with: rashbase-studio" ;;
      *) info "Add $bindir to your PATH, then launch it with: rashbase-studio" ;;
    esac
    ;;
esac
