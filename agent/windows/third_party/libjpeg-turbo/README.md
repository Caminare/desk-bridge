# libjpeg-turbo (vendored)

`turbojpeg.dll` is the TurboJPEG library from the official libjpeg-turbo release, used by
`TurboJpegTileEncoder` to encode JPEG tiles. It is committed so that a clone builds and runs
without extra steps. The publish step bundles it into the single-file agent `.exe`.

| | |
| --- | --- |
| Version | 3.2.1 |
| Source | `libjpeg-turbo-3.2.1-vc-x64.exe` from https://github.com/libjpeg-turbo/libjpeg-turbo/releases/tag/3.2.1 |
| Installer SHA-256 | `1f05bc3ed1585e6b12a8b0c24c8c5f07b1f6d90d01b4b709b331bedc9d6e5838` (matches the digest GitHub reports) |
| DLL SHA-256 | see `turbojpeg.dll.sha256`, verified in CI |

## Why vendored

libjpeg-turbo publishes no official NuGet package, and the community packages that ship the native
DLL are either stale or have a single maintainer and little use. The agent runs this code with the
user's rights on a machine it controls remotely, so we take the official binary and pin its hash.

## License

TurboJPEG is BSD-3-Clause; parts of libjpeg are under the IJG license (see `LICENSE.md` and
`README.ijg`, copied unchanged from the release). Binary redistribution must ship both files and the
IJG notice: "This software is based in part on the work of the Independent JPEG Group."

## Updating

1. In `agent/windows/eng/fetch-turbojpeg.ps1`, bump `$Version` and `$Sha256` (the new installer's SHA-256).
2. Run it (needs 7-Zip). It extracts the DLL and license files here and rewrites `turbojpeg.dll.sha256`;
   the installer is never executed.
3. Update the version table above, run the encoder tests, and commit everything in this folder.
