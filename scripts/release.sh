#!/usr/bin/env bash
#
# Cut a release: bump the version in every manifest, commit, tag, push.
# The `release` workflow picks the tag up and publishes a draft GitHub release
# with the macOS, Windows and Linux artifacts attached.
#
#   ./scripts/release.sh 0.2.0
#   ./scripts/release.sh 0.2.0 --dry-run

set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

version="${1:-}"
dry_run=""
[ "${2:-}" = "--dry-run" ] && dry_run=1

[ -n "$version" ] || die "usage: $0 <version> [--dry-run]"
version="${version#v}"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
  || die "version must be semver, e.g. 0.2.0"

tag="v$version"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

# --- bump ------------------------------------------------------------------

info "Bumping to $version"

# Each file has exactly one version field to touch, and it is the first one:
# package.json's own "version", the Tauri config's "version", and the
# [package] version in Cargo.toml.
perl -0pi -e 's/("version":\s*")[^"]+(")/${1}'"$version"'${2}/' package.json
perl -0pi -e 's/("version":\s*")[^"]+(")/${1}'"$version"'${2}/' src-tauri/tauri.conf.json
perl -0pi -e 's/^(version\s*=\s*")[^"]+(")/${1}'"$version"'${2}/m' src-tauri/Cargo.toml

# Keep Cargo.lock in step so the tagged commit builds reproducibly.
(cd src-tauri && cargo update -p rashbase-studio --offline >/dev/null 2>&1) \
  || info "could not refresh Cargo.lock offline; run 'cargo check' in src-tauri if the build complains"

git --no-pager diff --stat

if [ -n "$dry_run" ]; then
  info "Dry run: reverting the bump"
  git checkout -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  exit 0
fi

# --- commit, tag, push ------------------------------------------------------

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "release: $tag"
git tag -a "$tag" -m "Rashbase Studio $version"

branch="$(git rev-parse --abbrev-ref HEAD)"
info "Pushing $branch and $tag"
git push origin "$branch"
git push origin "$tag"

info "Pushed. The release workflow will attach the artifacts to a draft release:"
info "  https://github.com/native-productions/rashbase-studio/releases"
info "Review the draft, then publish it."
