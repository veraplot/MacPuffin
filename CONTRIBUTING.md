# Contributing to MacPuffin

Thanks for taking an interest. This project stays small on purpose, so a few
rules are non-negotiable — CI enforces every one of them.

## The two hard rules

1. **No dependencies.** Not runtime, not dev, not build. If the standard
   library and the macOS command-line tools cannot do it, we either write it or
   we do without. The `audit` CI job fails on any non-builtin import, and on
   the appearance of `node_modules` or a lockfile.
2. **No outbound network calls from the server.** The server contains no
   `fetch`, `http.request`, `net.connect`, `dgram` or WebSocket, and the socket
   binds `127.0.0.1`. CI greps for all of these.

   The native shell makes exactly one external request — the anonymous version
   check against `api.github.com`. CI holds `native/*.swift` to a host
   allowlist, so adding a second destination fails the build. Nothing that
   reads or reports on a user's files may ever contact the network.

## Also enforced

- **No shell.** Use `execFile` with an argv array. Never `exec`, never
  `shell: true`, never string concatenation into a command.
- **Deletes stay reversible.** Anything destructive goes through
  `lib/trash.js`. Never call `fs.rm` or `fs.unlink` on a user's file.
- **Coverage stays above 70%** on `lib/`.

## Getting set up

```bash
git clone git@github.com:veraplot/MacPuffin.git
cd macpuffin
npm start               # no install step — there is nothing to install
npm test
./build-app.sh          # builds MacPuffin.app
```

You need macOS 11+, Node 20+, and the Xcode command-line tools for the Swift
parts (`xcode-select --install`).

## Before opening a pull request

```bash
npm run test:coverage   # needs Node 22+; the flags do not exist in Node 20
```

If you touched anything in `lib/trash.js`, add a test for it. That file decides
what may be deleted, and it is the one place where a mistake costs a user their
files.

If you touched the UI, run the app and look at it — the layout is hand-written
CSS with no build step, so there is no type checker to catch a broken selector.

## Adding a cleanup location

`JUNK_TARGETS` in `lib/scan.js` is the list. Each entry needs a `safety` rating:

- `safe` — macOS or the owning tool rebuilds the contents automatically
- `review` — reclaimable, but the user should look first
- `danger` — listed for visibility, selection disabled

If the folder is a standard macOS location that cannot be moved, add it to
`CONTAINER_ONLY` in `lib/trash.js` so it is emptied rather than moved.

## Commit messages

Plain and descriptive. Explain why, not what — the diff already says what.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
