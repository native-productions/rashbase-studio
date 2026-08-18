#!/usr/bin/env bash
#
# Cut a release: bump the version in every manifest, commit, tag, push, then
# trigger the release workflow. The workflow publishes a draft GitHub release
# with the built artifacts attached.
#
#   ./scripts/release.sh 0.2.0                  # all platforms
#   ./scripts/release.sh 0.2.0 linux,windows    # only those two
#   ./scripts/release.sh 0.2.0 macos --dry-run  # show the bump, change nothing
#
# Platforms: macos (builds both Apple Silicon and Intel), windows, linux.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO="native-productions/rashbase-studio"
WORKFLOW="release.yml"
ALL_PLATFORMS="macos,windows,linux"
KNOWN_PLATFORMS="macos windows linux"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
usage() { die "usage: $0 <version> [platforms] [--dry-run]  (platforms: $KNOWN_PLATFORMS)"; }

# --- arguments --------------------------------------------------------------

version=""
platforms=""
dry_run=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage ;;
    -*) die "unknown flag: $arg" ;;
    *)
      if [ -z "$version" ]; then version="$arg"
      elif [ -z "$platforms" ]; then platforms="$arg"
      else die "unexpected argument: $arg"
      fi
      ;;
  esac
done

[ -n "$version" ] || usage

version="${version#v}"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
  || die "version must be semver, e.g. 0.2.0"
tag="v$version"

platforms="${platforms:-$ALL_PLATFORMS}"
# Validate here rather than letting the workflow reject it, so a typo never
# leaves a pushed tag with no build behind it.
for p in $(printf '%s' "$platforms" | tr -d '[:blank:]' | tr ',' ' '); do
  case " $KNOWN_PLATFORMS " in
    *" $p "*) ;;
    *) die "unknown platform '$p' (known: $KNOWN_PLATFORMS)" ;;
  esac
done

# --- preflight --------------------------------------------------------------

command -v gh >/dev/null 2>&1 || die "the GitHub CLI (gh) is required: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

# --- bump -------------------------------------------------------------------

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
  info "Would have tagged $tag and built: $platforms"
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

# --- build ------------------------------------------------------------------

info "Triggering the release workflow for $platforms"
gh workflow run "$WORKFLOW" --repo "$REPO" \
  --field tag="$tag" \
  --field platforms="$platforms"

info "Watch it here:"
info "  https://github.com/$REPO/actions/workflows/$WORKFLOW"
info "When it finishes, review the draft release and publish it:"
info "  https://github.com/$REPO/releases"
