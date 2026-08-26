# Development notes

## Layout

```
build.mjs          esbuild bundling: ES modules in, one IIFE userscript out
src/
  meta.txt         the ==UserScript== header, prepended verbatim (single
                   source of truth; its @version is injected into the code)
  main.js          entry point: registers modules, boots
  core.js          module registry, serialized HTTP queue, settings registry,
                   DOM / storage / secret-storage helpers; knows no pages
  adapters/        everything that knows the server: protocols, HTML parsing
  lib/             cross-cutting client state (e.g. favourite market lists)
  ui/              everything that renders. Never touches server HTML
dist/clop.user.js  build output: the installable file
```

## Architecture

`src/adapters/` is the only place that knows the server's HTML shape and form vocabulary; `src/ui/` renders snapshot objects obtained through adapter interfaces. So when the site's markup drifts, the fix is confined to the adapters' `parse*` functions — and if a real API ever appears, a new adapter will limit the changes needed in the ui/ code to mostly the interfaces.

## Dev loop

```sh
npm install
npm run build
```
Optionally:
```
npm run watch      # rebuild dist/clop.user.js on every source change
```

Install the script in Violentmonkey from `file:///.../dist/clop.user.js` — it offers to track the file, so a page reload picks up every rebuild. (Tampermonkey can do the same if "Allow access to file URLs" is enabled for the extension.) For a local dev instance, add a `@match` line to `src/meta.txt`.

The script exports a debug handle to the page window: `clopX` (e.g. `clopX.settings.all()`, `clopX.autologin.forget()`, or registering an ad-hoc module from the console).

## Releasing

1. Bump `@version` in `src/meta.txt`, rebuild, commit.
2. Create an annotated tag — its message becomes the release notes — and push it:

   ```sh
   git tag -a v0.4.0     # editor opens for the notes
   git push origin v0.4.0
   ```

3. The release workflow (`.github/workflows/release.yml`) rebuilds from the tag and publishes a GitHub release with `dist/clop.user.js` attached. Installed copies pick the new version up via `@updateURL`, which points at the latest release.

## Adding a module

A module is `{ name, matches(page, location), settings?(core), init(core) }`. `settings()` registers the module's `core.settings.define()` entries and runs on every page regardless of `matches()` (the settings panel is global); `init()` is the page-scoped UI. Create the module in `src/ui/`, register it in `src/main.js`, rebuild. If it needs new server interactions, keep the protocol and parsing in a `src/adapters/` file.

## Safe-action catalogue

`src/data/actions.generated.js` pairs each action's mechanics with the normalized description from the same CLOP backend snapshot. At runtime, action safety uses those mechanics only when the live name and description still match exactly (apart from whitespace). A mismatch is deliberately treated as incompatible rather than guessing from prose.

The initial snapshot can be regenerated from a CLOP SQL dump with:

```sh
node scripts/generate-action-data.mjs "/path/to/tables with data.sql"
```

For a live rebalance that is not available as structured data, update the affected action and its description together in `src/data/actions.generated.js`; update its entry in `BUILDING_UPKEEP` too when its resulting building upkeep changed. New actions need a complete catalogue entry before the script will protect them.
