#!/usr/bin/env bash
# Fetches turbojpeg.dll (libjpeg-turbo 3.2.1, VC x64 build) into third_party/libjpeg-turbo/.
# Downloads the pinned installer into a fresh temp dir, verifies SHA-256, extracts with 7z.
# The installer is never executed. Works from Git Bash on Windows and from Linux/macOS with 7z.
set -euo pipefail

VERSION=3.2.1
ASSET="libjpeg-turbo-${VERSION}-vc-x64.exe"
URL="https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/${VERSION}/${ASSET}"
SHA256=1f05bc3ed1585e6b12a8b0c24c8c5f07b1f6d90d01b4b709b331bedc9d6e5838

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:-$here/../third_party/libjpeg-turbo}"

seven=""
for c in 7z 7za 7zz; do
  if command -v "$c" >/dev/null 2>&1; then seven="$c"; break; fi
done
if [ -z "$seven" ]; then
  for c in "/c/Program Files/7-Zip/7z.exe" "/c/Program Files (x86)/7-Zip/7z.exe"; do
    if [ -x "$c" ]; then seven="$c"; break; fi
  done
fi
[ -n "$seven" ] || { echo "7z was not found. Install 7-Zip and re-run." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading $URL"
curl -fsSL -o "$work/$ASSET" "$URL"

actual="$(sha256sum "$work/$ASSET" | cut -d' ' -f1)"
[ "$actual" = "$SHA256" ] || { echo "SHA-256 mismatch for $ASSET. Expected $SHA256, got $actual." >&2; exit 1; }

"$seven" x -y "-o$work/extracted" "$work/$ASSET" >/dev/null

dll="$(find "$work/extracted" -type f -name turbojpeg.dll | sort | grep -i '/bin/' | head -n1 || true)"
[ -n "$dll" ] || dll="$(find "$work/extracted" -type f -name turbojpeg.dll | head -n1)"
[ -n "$dll" ] || { echo "turbojpeg.dll is not in $ASSET." >&2; exit 1; }

mkdir -p "$dest"
cp "$dll" "$dest/turbojpeg.dll"
for name in LICENSE.md README.ijg; do
  lic="$(find "$work/extracted" -type f -name "$name" | head -n1)"
  if [ -n "$lic" ]; then cp "$lic" "$dest/$name"
  else echo "warning: $name was not found in the archive; add it to $dest before distributing." >&2; fi
done
echo "turbojpeg.dll $VERSION installed to $dest"
