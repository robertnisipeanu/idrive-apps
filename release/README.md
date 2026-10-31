# Releases

`release.js` builds the repository's components from HEAD and publishes
them with the catalog the [mgu Store](https://github.com/robertnisipeanu/mgu-store)
reads (its `docs/PUBLISHING.md`, "2. Catalog"): each tool with a
`native/<id>/component.json` as a tool kit, each app with an
`apps/<id>/release.json` (a source package the head unit builds).

```sh
node release/release.js list                          # versions and publish state
node release/release.js build [<id>...]               # artifacts and catalog.json into release/out/
node release/release.js check [<id>...]               # build twice, compare byte for byte
node release/release.js bump <id> <x.y.z>             # set a component's version
node release/release.js publish [<id>...] [--dry-run] # (GitHub Actions) new versions, then the catalog
MGU_PUBLISH=dir:<folder> node release/release.js publish   # a local catalog (emulator, USB stick)
node release/test/release_test.js
```

**Versions.** One version has exactly one artifact. Builds run on
`git archive HEAD` with `SOURCE_DATE_EPOCH` from the last commit that
touched what the component ships. A change to that needs a new version
(`bump`); `publish` skips a version already published with other bytes.
A tool kit holds what mgu-store's `deploy/hu artifact` packs, byte for byte.

**Catalog.** The release `catalog` holds `catalog.json` (schema 2); each
version is the release `<id>@<version>`, its artifact the one asset.

| Entry | Fields |
|---|---|
| `cluster-render` (tool) | `requires: {"mgu-deploy": "0.4.0"}`, `uninstallable`, `mguHmi: ["ID7"]` (`native/cluster-render/component.json`) |
| `waze-on-cluster` (tool) | `requires: {"mgu-deploy": "0.7.0", "cluster-render": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`native/waze-on-cluster/component.json`) |
| `robertn_waze_cluster` (app) | `build: "unit"`, `requires: {"waze-on-cluster": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/robertn_waze_cluster/release.json`) |

The catalog is not signed: the Store fetches it over HTTPS and checks each
artifact's size and sha256 against it.

**Publishing.** `.github/workflows/release.yml` runs `publish` on a `v*` tag,
or by hand (Actions, Release, with the component ids or none for all), from
`main`, with the workflow's `GITHUB_TOKEN` (`contents: write`). It publishes
whether this repository is private or public
(`MGU_PUBLISH_VISIBILITY=any`). `.github/workflows/test.yml` runs every
test, both head-unit builds and `check` on every push and pull request.

## License

GPL-3.0-or-later (`LICENSE` at the repository root).
