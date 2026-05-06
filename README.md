# Nuvio Desktop

<div align="center">
  <img src="https://github.com/tapframe/NuvioTV/raw/dev/assets/brand/app_logo_wordmark.png" alt="Nuvio TV" width="300" />
  <br />
  <br />
  <strong>Standalone desktop localization of the Nuvio TV web app.</strong>
</div>

## Desktop Fork Notes

This branch keeps the upstream Nuvio TV web experience, then adapts it for a standalone desktop app. The goal is to make the app feel native on a laptop or desktop monitor instead of behaving like a fixed-size TV surface that expects only directional keys.

The desktop changes are intentionally platform-scoped:

- Tauri desktop packaging for local macOS builds and standalone launch.
- Production-compatible runtime config through `nuvio.env.js`, without committing secret values.
- Direct email/password login for desktop users, without routing standalone desktop flows through phone pairing.
- In-app addon management for desktop: install manifest URLs, refresh, reorder, remove, and open home catalog ordering without a QR handoff.
- Stable desktop display scaling through native Tauri webview zoom plus the existing in-app UI scale preference.
- Desktop-only compact density rules for TV-sized route panels, stream selection cards, settings rows, and account screens.
- Mouse-first interaction support: clicked focusables activate like Enter, player controls are clickable, and nested routes expose a desktop back button.
- Route sizing is normalized across Home, Search, Discover, Detail, Stream Selection, Player, Cast, See All, Library, Settings, Account, and auth screens.

Why these changes exist: the upstream app is a 10-foot TV interface, so many controls were sized for remote navigation at couch distance. On desktop, that made selection components feel 2-3x too large, caused DPI-dependent flicker, and left some routes without an intuitive mouse path back. The desktop fork fixes those issues while preserving the original artwork, metadata, and playback model.

## Upstream Credit

This work depends on and credits the upstream Nuvio ecosystem:

- [tapframe/NuvioTV](https://github.com/tapframe/NuvioTV) - original Android TV project and product direction.
- [WhiteGiso/NuvioTV-WebOS](https://github.com/WhiteGiso/NuvioTV-WebOS) - community webOS codebase that helped shape the shared web version.
- [NuvioMedia/NuvioTVTizen](https://github.com/NuvioMedia/NuvioTVTizen) - Tizen wrapper.
- [NuvioMedia/NuvioWebOS](https://github.com/NuvioMedia/NuvioWebOS) - webOS wrapper.

This repository is a downstream desktop-focused fork of the shared web app. Changes should stay compatible with upstream behavior unless the difference is necessary for standalone desktop use.

## What This App Does

Nuvio TV is a client-side media interface built around metadata browsing, Stremio-compatible addon discovery, source resolution, and playback. The app does not host media. Users are responsible for using sources and addons they are authorized to access.

The same web source can run in:

- A browser or hosted web environment.
- TV wrappers for Tizen and webOS.
- The Tauri desktop shell in this fork.

## Repository Structure

- `js/` - app logic, platform adapters, auth, routing, playback, and screens.
- `css/` - shared styling and desktop-specific density overrides.
- `assets/` - icons, branding, images, and bundled browser libraries.
- `scripts/` - build, serving, release, and wrapper sync tooling.
- `src-tauri/` - desktop app shell and native display zoom integration.
- `tests/` - focused Node test coverage for auth, add-ons, display scaling, and mouse navigation.
- `dist/` - generated build output.

## Requirements

- Node.js with npm.
- Rust toolchain for Tauri desktop builds.
- Tauri prerequisites for your OS.
- Optional platform SDKs for Tizen or webOS wrapper packaging.

## Runtime Configuration

The app reads runtime configuration from `nuvio.env.js` before loading `app.bundle.js`.

For local development:

```bash
cp nuvio.env.example.js nuvio.env.js
```

Then fill in the public runtime values your deployment requires, such as:

```js
window.__NUVIO_ENV__ = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: ""
};
```

Do not commit production secrets or private credentials. The Supabase anon key is still a public client key, but this fork keeps local and production environment values outside committed source.

## Web Development

Install dependencies:

```bash
npm install
```

Build the web bundle:

```bash
npm run build
```

Serve the built app:

```bash
npm run serve
```

By default the local server uses `http://127.0.0.1:4173`.

## Desktop Development

Run the Tauri app in development:

```bash
npm run tauri:dev
```

Build a local macOS app bundle without updater artifacts:

```bash
npm run tauri:build:local
```

The app bundle is written to:

```text
src-tauri/target/release/bundle/macos/Nuvio TV.app
```

Launch the built app on macOS:

```bash
open -na "src-tauri/target/release/bundle/macos/Nuvio TV.app"
```

## Desktop QA Checklist

Before shipping desktop changes, run:

```bash
node --test tests/addonUrl.test.mjs tests/addonsManager.test.mjs tests/desktopStandalone.test.mjs tests/displayScale.test.mjs tests/authManager.test.mjs tests/mouseNavigation.test.mjs
cd src-tauri && cargo test
git diff --check
npm run tauri:build:local
```

Also launch the built app and verify:

- No big-small frame flicker on startup or route changes.
- Selection cards and settings rows stay desktop-sized.
- Original artwork remains visible and proportionate.
- Mouse click opens media, stream cards, settings actions, account actions, and player controls.
- Desktop back controls return from Detail, Stream Selection, Player, Cast, and See All routes.
- Email/password login works when `nuvio.env.js` is configured.
- Addons can be managed directly from the Addons route, including home catalog ordering.

## TV Wrapper Builds

The public Tizen and webOS wrappers can point at a hosted build. This repo also includes sync tooling for developers who want fully packaged custom wrappers.

### webOS

Create a separate webOS project folder with at least:

```text
YourWebOSProject/
  appinfo.json
  index.html
  main.js
```

Sync the built app into that wrapper:

```bash
npm run build
npm run sync:webos -- /absolute/path/to/YourWebOSProject
```

For a local IPK directly from this repo:

```bash
npm run package:webos
npm run install:webos -- -d lg
npm run inspect:webos -- -d lg
npm run logs:webos -- -d lg
```

### Tizen

Create a separate Tizen project folder with at least:

```text
YourTizenProject/
  config.xml
  index.html
  main.js
```

Sync the built app into that wrapper:

```bash
npm run build
npm run sync:tizen -- /absolute/path/to/YourTizenProject
```

Package and install with Tizen Studio or your normal Samsung TV workflow.

## Legal

Nuvio TV functions solely as a client-side interface for browsing metadata and playing media provided by user-installed extensions or user-provided sources.

This project is intended for content the user owns or is otherwise authorized to access. It is not affiliated with third-party extensions or content providers and does not host, store, or distribute media content.

## License

Respect the licenses and notices of the upstream projects credited above. Document any additional license terms for this desktop fork before public distribution.
