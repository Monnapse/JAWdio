## JAWDIO

Electron + Next.js soundboard and live clipper.

## Development

Install dependencies, then run the desktop app in dev mode:

```bash
npm install
npm run dev
```

That starts Next on port `3000` and opens Electron against it.

## Build A Windows Installer

```bash
npm install
npm run dist
```

The installer output lands in `dist/` as a Windows `Setup.exe`.

## What The Packaging Setup Does

- Builds Next in `standalone` mode.
- Copies only the static assets Electron needs into `.next/standalone`.
- Creates an NSIS installer with `electron-builder`.
- Stores user-created sounds and clips in the user's app data folder instead of the install directory.

On Windows, runtime media is stored under the installed user's app data area for `JAWDIO`, not inside `Program Files`.

## Important

- Do not ship `.env.local` inside the installer.
- Do not bundle private API keys you do not want recipients to extract.
- The first `npm install` after these changes will update `package-lock.json` because `electron-builder` was added.

If SmartScreen warns on another machine, that is normal for unsigned Windows apps. Code signing is the next step if you want a smoother install experience.
