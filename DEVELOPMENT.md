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
  ui/              everything that renders. Never touches server HTML
dist/clop.user.js  build output: the installable file
```

## Architecture

`src/adapters/` is the only place that knows the server's HTML shape and
form vocabulary; `src/ui/` renders snapshot objects obtained through adapter
interfaces. So when the site's markup drifts, the fix is confined to the
adapters' `parse*` functions — and if a real API ever appears, a new adapter
will limit the changes needed in the ui/ code to mostly the interfaces.

## Dev loop

```sh
npm install
npm run build
```
Optionally:
```
npm run watch      # rebuild dist/clop.user.js on every source change
```

Install the script in Violentmonkey from
`file:///…/dist/clop.user.js` — it offers to track the file, so a page
reload picks up every rebuild. (Tampermonkey can do the same if "Allow
access to file URLs" is enabled for the extension.) For a local dev
instance, add a `@match` line to `src/meta.txt`.

The script exports a debug handle to the page window: `CLOPUS` (e.g.
`CLOPUS.settings.all()`, `CLOPUS.autologin.forget()`, or registering an
ad-hoc module from the console).

## Releasing

1. Bump `@version` in `src/meta.txt`, rebuild, commit.
2. Create an annotated tag — its message becomes the release notes — and
   push it:

   ```sh
   git tag -a v0.4.0     # editor opens for the notes
   git push origin v0.4.0
   ```

3. The release workflow (`.github/workflows/release.yml`) rebuilds from the
   tag and publishes a GitHub release with `dist/clop.user.js` attached.
   Installed copies pick the new version up via `@updateURL`, which points
   at the latest release.

## Adding a module

A module is `{ name, matches(page, location), init(core) }`. Create it in
`src/ui/`, register it in `src/main.js`, rebuild. If it needs new server
interactions, keep the protocol and parsing in a `src/adapters/` file.
