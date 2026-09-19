# Security Policy

MacPuffin reads your whole home folder and can move files to the Trash. That is
a lot of authority for a small tool, so the design is built to make the blast
radius small, auditable, and reversible.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/veraplot/MacPuffin/security/advisories/new)
on this repository. Please do not open a public issue for anything exploitable.

Include the macOS version, the Node version, and the smallest set of steps that
reproduces the problem. We aim to acknowledge within 72 hours.

## Threat model

| Asset | Threat | Control |
|---|---|---|
| Your files | Accidental or malicious deletion | Nothing is unlinked; every delete is a `rename()` into `~/.Trash` via `FileManager.trashItem`. Reversible until you empty the Trash. |
| Your files | A path outside the intended scope | Server-side allow/deny check on every mutation: home folder only, plus a hard-coded protected list. |
| Your data | Exfiltration to a remote host | No outbound network primitive exists in the server. Socket binds `127.0.0.1`. CSP forbids every off-origin connection. The native shell makes exactly one anonymous request, to GitHub, carrying no data — see below. |
| Your machine | Command injection via a filename | No shell is ever spawned. All commands use `execFile` with an argv array. |
| The browser UI | CSRF from another page | Mutations require an `x-macpuffin` header plus a same-origin `Origin`. |
| The browser UI | XSS via a filename | All interpolated values are HTML-escaped; CSP blocks inline and remote scripts. |
| The supply chain | A malicious transitive dependency | There are no dependencies at all. |

## Controls in detail

### No dependencies

`package.json` declares no `dependencies` and no `devDependencies`. There is no
`node_modules`, no lockfile, and nothing is fetched from a registry. Every
import resolves to a Node builtin or a local file:

```
node:path  node:os  node:fs  node:fs/promises  node:http
node:crypto  node:child_process  node:url  node:util
```

CI fails the build if a non-builtin import or a lockfile ever appears.

### No outbound network from the server

The server contains no `fetch`, `http.request`, `net.connect`, `dgram`,
WebSocket or DNS call. CI greps for these and fails if one is introduced. Your
files are read, analysed and reported entirely within this machine; there is no
code path by which a filename, a path or a byte of your data can leave it.

The listening socket is bound to `127.0.0.1` explicitly, never `0.0.0.0`, so
nothing off the machine can reach it. CI asserts this too.

### The one external request

The native shell — not the server, and not the page — asks GitHub once per
launch whether a newer release exists:

```
GET https://api.github.com/repos/veraplot/MacPuffin/releases/latest
```

What that means in practice:

- **Anonymous.** No account, no token, no device or install identifier, no
  usage data. GitHub sees an IP address and a `User-Agent` of `MacPuffin`, the
  same as opening the releases page in a browser.
- **Read-only.** Nothing is sent about your machine, your files or your scans.
  The request has no body and no query string.
- **Optional.** A 6-second timeout, an ephemeral session, and every failure
  path swallowed. Offline, behind a firewall, rate-limited or blocked: the app
  works exactly the same and simply shows no banner.
- **Silenceable.** `defaults write local.macpuffin.app disableUpdateCheck -bool YES`
  disables it permanently.
- **Never auto-installs.** The banner links to the release page, which opens in
  your browser. The app downloads and executes nothing.

`public/app.js` still makes only same-origin `fetch('/api/…')` and
`EventSource` calls; the CSP `connect-src 'self'` continues to forbid the page
itself from reaching any outside host.

### Content Security Policy

Every page response carries:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; font-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`connect-src 'self'` means that even if an attacker could inject content into
the page, it has no permitted channel to an outside host. `'unsafe-inline'`
appears for **style only** — the bars and gauges set their width through style
attributes. Scripts stay strict: no inline, no `eval`.

### No shell, ever

Commands run through `execFile` with an argument array — never `exec`, never
`shell: true`, never string concatenation. A filename containing `; rm -rf ~`
is passed as one literal argument. The complete set of binaries the app may
invoke:

```
df  vm_stat  sysctl  ps  top  pmset  mdfind  mdls  open  osascript  mptrash
```

`osascript` is called with exactly one fixed literal — `tell application
"Finder" to empty the trash` — with no interpolation of any kind.

### Removing applications

macOS protects signed application bundles. Since Ventura, deleting one requires
the **App Management** privilege, which an ad-hoc signed tool does not hold, so
the attempt returns `EACCES` regardless of who owns the files.

When that happens MacPuffin asks **Finder** to do it instead — Finder holds the
privilege and prompts for an administrator password if the bundle needs one.
The item still lands in the Trash and is still recoverable. The path handed to
Finder is already constrained to `/Applications/<name>.app`, and quotes and
backslashes in the name are escaped so it cannot break out of the AppleScript
string literal. Every step is logged: `trash.appBlocked` then `trash.finder`.

### Deletion guards

Three checks run before any filesystem call:

1. **Outside home is refused.** The one exception is an app bundle directly in
   `/Applications`, so the Applications view can uninstall.
   `/System/Applications` remains blocked.
2. **A protected list is refused even inside home**: `~`, `~/Documents`,
   `~/Desktop`, `~/Downloads`, `~/Pictures`, `~/Movies`, `~/Music`,
   `~/Library`, `/`, `/System`, `/Library`, `/usr`, `/etc`, `/Volumes`.
   Paths are resolved first, so `~/Downloads/../../etc/passwd` is caught.
3. **macOS-owned container folders are refused** with an explanation pointing
   at the operation that does work — emptying the contents.

The confirmation dialog lists every path before anything moves, and the
selection is never widened on the server side.

### Audit trail

Every move, refusal and failure is appended to
`~/Library/Logs/MacPuffin/macpuffin.log` with a timestamp, a level, the path and
the errno. Nothing destructive happens silently.

## What is deliberately not protected

- The app is **unsandboxed** and can read your entire home folder. That is the
  function of a disk analyser.
- The app is **ad-hoc signed**, not Developer ID signed or notarised. You are
  trusting this source tree, which is small enough to read end to end.
- `Empty Trash` is **irreversible** by design. It delegates to Finder and
  erases everything in the Trash, not only what MacPuffin put there.
- The local HTTP server is reachable by **any process running as your user** on
  this machine. Loopback binding stops remote access, not local processes.
