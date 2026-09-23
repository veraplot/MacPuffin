# Release Notes

All notable changes to MacPuffin. Newest first.

---

## v1.0.1 — 2026-09-23

Everything the first release got wrong about being interrupted, plus the
interface rebuilt around the numbers instead of around a grid of boxes.

### Pause and resume

A scan can now be held where it stands instead of only being abandoned.

- **Pause** stops the walk at its current position without discarding anything. Every count, every collector and every list stays exactly as it was; **Resume** carries on from the same directory rather than starting over.
- Pausing shows what has been found so far. The large files, stale files, category breakdown and folder breakdown all appear at the moment you pause, so a pause is a way of reading a long scan early rather than a way of interrupting it blindly.
- Duplicates are the one exception, and they say so: a duplicate group has no meaning until the whole walk has been compared, so a paused scan reports none rather than reporting a wrong number.
- The progress strip states that it is paused, stops advancing, and keeps the path it stopped on visible as the resume point.
- **Stop** still works on a paused scan. A held walk is woken and abandoned, so a pause is never a state you have to quit the app to get out of.
- The hold reaches inside the slow parts too. Measuring one enormous folder used to be uninterruptible for minutes at a time, which made Pause look broken on the Cleanup, Applications and Storage views; the folder measurement now honours the same control.
- Closing the window during a pause releases the held walk instead of leaving it parked on a file handle.

### Folders macOS would not let us read

- Unreadable folders are now counted and reported instead of being treated as empty. Previously a folder the system refused was indistinguishable from a folder with nothing in it, so a Mac where the Desktop or Documents permission prompt had been declined reported a total that was quietly too low, with no indication anything was missing.
- The summary names how many folders were refused and points at System Settings › Privacy & Security › Files and Folders. A measurement that cannot see everything now says so rather than understating the result.

### Interface

Rebuilt against a written design system — `DESIGN.md` is the contract, and every
colour, size and spacing value in the stylesheet traces to a token named there.

- The grid of nine near-identical cards is gone. Summary figures now live in one dense strip whose cells are sized by importance, and each view has a single primary element instead of nine competing ones.
- One type scale of seven steps replaces the fifteen ad-hoc font sizes the first release accumulated. Every figure is tabular, so columns of numbers align on the digit.
- Depth comes from value steps and a single hairline rather than from shadows and glows.
- The red-and-blue identity gradient is used in exactly three places, all of them things you did rather than things the app noticed: the primary action of a view, the active navigation marker, and a checked selection box. Selection ticks previously used the amber attention colour, which conflated your choices with the app's warnings.
- The disk meter carries blue → amber → red as a scale on its track, so the colour describes how full the disk is rather than decorating the bar.
- The progress strip lives in the shell rather than inside a view, so a scan started on one screen stays visible when you move to another — which is exactly when you go looking for it. Previously the Duplicates screen showed no progress at all while its own scan was running.

### Update notices

- The update banner now offers three distinct choices rather than one ambiguous "Later": close it to be reminded next launch, **Skip this one** to never hear about that particular version again, or **Never** to stop announcing versions altogether.
- **Never** is reversible. *Check for Updates…* in the MacPuffin menu clears every dismissal and asks again, so muting the notice is not a dead end.
- The banner names both versions and says the download opens in your browser, that nothing installs itself, and that your settings survive installing over the existing copy.

### Reliability

- A stale or unrelated program holding MacPuffin's port no longer breaks the app. A server already running is reused only after it reports this exact version and proves it can serve the interface; anything else is stepped over and the next free port is used, and if all ten preferred ports are taken the app asks the system for any free port rather than refusing to open. This is the cause of the `{"error":"not found"}` screen some 1.0.0 downloads showed.

### Verified on this release

- 142 automated tests across unit, filesystem, live-server and real-machine suites; 92.8% line coverage, 79.3% branch coverage and 89.7% function coverage of the library code, enforced by the build and independent of what happens to be installed on the machine running them.
- Pause and resume are covered by 19 tests of the control itself and 4 against a live server: that a held walk does not advance, that resuming continues the same walk rather than restarting it, that stopping a paused scan keeps exactly what the pause was showing, and that both routes refuse a request without the anti-CSRF header.
- Continuous integration runs with a read-only token, and now refuses to adopt a server it did not start — a leftover process answering on the test port used to make every later assertion meaningless.

### Known limitations

- The storage map draws proportional bars rather than a treemap.
- The window paints opaque surfaces; only the title bar carries the platform's translucent material.
- Light mode is not built.

---

## v1.0.0 — 2026-09-19

First public release. A local-only cockpit for macOS: it measures where the
disk went, what memory is under pressure, and what can safely be reclaimed —
then reclaims it reversibly.

Universal build (Apple Silicon + Intel), macOS 11 Big Sur or newer, zero
dependencies, no network access of any kind.

### Cockpit

The landing view, refreshed every 2.5 seconds.

- Startup disk gauge showing free space, total capacity and percentage used, with the headline changing as the disk fills.
- Live status pills for CPU load, memory pressure and uptime, turning amber above 80% CPU or 88% memory.
- Six summary cards — Cleanup, Large files, Old files, Duplicates, Applications, Memory — each jumping to its full view.
- Top eight memory consumers and top eight CPU consumers, aggregated per application rather than per process, so a browser with 70 helpers reads as one row.
- Persistent sidebar gauges for disk and memory that stay visible in every view.
- One "Scan this Mac" button runs the junk, applications and deep scans together.
- Stop a scan at any point and keep what it found. The walk ends early, the results already collected are delivered in full, and every panel marks itself as a partial scan so the numbers are never mistaken for a complete picture.
- Application icons throughout: the real bundle icon appears beside every app in the consumer lists and the Applications view, read straight from each bundle and cached.
- Status pills carry an icon each, and uptime is spelled out as "since restart" rather than an unlabelled duration.

### Cleanup

Twenty-three known reclaimable locations, measured with real sizes and file counts.

- System junk: user caches, user logs, saved application state, crash reports, mail downloads.
- Developer leftovers: Xcode DerivedData, archives, iOS and watchOS device support, CoreSimulator caches and devices, Xcode previews, npm cache, pnpm store, yarn cache, Homebrew cache, pip cache, Go module cache, Cargo registry cache, Gradle caches, Docker data, generic dot-cache.
- Trash, with its own handling.
- Every row carries a safety rating — safe, review or danger. Safe means macOS or the owning tool rebuilds the content automatically. Danger rows cannot be selected at all.
- Rows tagged "contents only" are the folders macOS refuses to let any process move; those have their contents emptied while the folder stays in place.
- Clean a single location with its Empty button, or tick several and clean them together.
- The list rescans automatically after a clean, so the figures stay honest.

### Large files

- The biggest single files in the home folder, with a threshold selectable from 100 MB to 5 GB.
- Two engines: a deep walk that sees everything, or a near-instant Spotlight query covering whatever is indexed.
- An "Include caches and node_modules" toggle switches between a fast scan and an exhaustive one.
- Reveal in Finder on any row.

### Old files

- Files over 10 MB that have not been opened or modified for 90 days, 6 months, 1 year or 2 years.
- Last-used date is the later of modification time and access time, so a file you only ever read still counts as used.
- Reports both the total count and the total bytes sitting idle.

### Duplicates

- Files are grouped by exact size, then confirmed with an MD5 fingerprint of the size plus the first and last 64 KB — fast enough to run over a whole home folder without reading multi-gigabyte files end to end.
- Considers files of 1 MB and above, fingerprints up to 4000 candidates, reports the 120 groups wasting the most space.
- Copies are sorted newest first and the newest is labelled, so it is obvious which one to keep.
- Groups collapse to four entries with a "show all" control, so a group of 52 copies does not bury the rest of the list.
- "Select all but newest" selects every redundant copy in one click.
- Each group shows the space wasted, not just the file size.

### Applications

- Every app in /Applications, /Applications/Utilities and ~/Applications with its size on disk and version number.
- Real last-used dates come from Spotlight rather than file access time, which is unreliable for bundles.
- Apps can be uninstalled to the Trash directly from the list.
- Signed application bundles, which macOS refuses to let an ad-hoc signed tool delete, are removed through Finder instead — the item still goes to the Trash and is still recoverable, and macOS asks for an administrator password when the bundle needs one.
- Failures are reported in plain language rather than as an errno: a blocked delete explains App Management, a busy file says to quit the app first.

### Storage map

- Every mounted volume with used, free and total capacity, including external drives and disk images.
- A home folder breakdown that fills in progressively as each folder is measured, instead of showing nothing for several minutes.
- A by-file-type breakdown across nine categories — applications, developer, video, audio, photos, documents, archives, code, virtual machines — plus everything else.

### Developer tools

- Python environments across the home folder: virtualenvs located by their pyvenv.cfg, conda environments, pyenv versions and the interpreters on PATH, each with size, version and last use.
- node_modules folders per project, with a package count that resolves scoped packages correctly, alongside the shared pnpm, npm and yarn stores that live outside any project.
- Docker images from the local store, largest first, with untagged layers marked and Docker's own reclaimable figure shown. Degrades to a clear explanation when Docker is absent or its daemon is not running.
- Each environment found can be revealed in Finder.

### Memory and CPU

- Memory split the way Activity Monitor splits it: app memory, wired, compressed, cached files and free, with swap used and swap allocated alongside.
- Memory pressure as a single percentage.
- Processor panel with user and system time, one, five and fifteen minute load averages, uptime, battery level and charging state where a battery exists.
- A rolling sparkline of the last sixty CPU samples.
- The full process list, aggregated per application bundle, sortable by memory or by CPU, showing how many processes each application is running.

### Safety

- Nothing is ever erased. Every delete is a move to the Trash through FileManager.trashItem, the same API Finder uses, so items keep working Put Back.
- Paths outside the home folder are refused. The single exception is an application bundle directly in /Applications, so uninstalling works; /System/Applications stays blocked.
- A protected list is refused even inside the home folder: the home folder itself, Documents, Desktop, Downloads, Pictures, Movies, Music and Library. Paths are resolved before the check, so relative traversal cannot slip through.
- macOS-owned container folders are refused with an explanation pointing at the operation that does work, rather than a raw error code.
- Every confirmation dialog lists the exact paths involved before anything moves, and the server never widens the selection it was given.
- A persistent banner tracks how much this session has moved to the Trash and states plainly that the disk does not get the space back until the Trash is emptied.
- Empty Trash is offered explicitly, delegated to Finder, and clearly marked as the one irreversible action.

### Reporting

- Report a bug and Request a feature open a pre-filled GitHub issue, with the machine specification already attached for bug reports.
- Errors are captured on both sides — the server records uncaught exceptions, rejected promises and failed requests; the interface records its own script errors — and surface as a banner rather than disappearing into a console.
- See report shows the complete text before anything is shared. Share the crash report opens a GitHub issue with it filled in; nothing is transmitted from the app and the submission is yours to make.
- Reports carry the error, the stack and the Mac specification. They carry no file names and no scan results, and the home folder and account name are removed before the report is displayed at all.
- Repeated faults are collapsed into one entry with a count, so a loop cannot fill the file.

### Audit trail

- Every move, refusal and failure is appended to ~/Library/Logs/MacPuffin/macpuffin.log with a timestamp, a level, the path, the destination and the error code.
- The same log is readable in-app through the logs endpoint, so a failed cleanup can always be explained after the fact.

### The application

- A native Cocoa window wrapping a WKWebView — real dock icon, resizing, full screen, and a menu bar with reload and quit.
- An optional update notice. Once per launch the shell asks GitHub whether a newer release exists and, if so, shows a dismissible banner linking to it. The request is anonymous, carries no data about you or your machine, times out after six seconds, and fails silently when offline. Nothing is ever downloaded or installed automatically. Disable it with: defaults write local.macpuffin.app disableUpdateCheck -bool YES
- Launching it starts the bundled server; quitting stops it. A server already running on the port is reused rather than duplicated.
- Self-contained: the app bundles the official universal Node runtime, so there is nothing to install beforehand. No Homebrew, no Terminal, no separate download — drag it to Applications and open it.
- Distributed as a compressed disk image of about 80 MB with an Applications drop target.
- Universal binary throughout, and the shell prefers a Node built for the host architecture: on a Mac with both an Intel and a native Homebrew, the native one is chosen so the server never runs under Rosetta. Architectures are read from the Mach-O header, needing no Xcode tools.

### Under the hood

- One filesystem walk produces large files, old files, duplicate candidates, category totals and folder totals together, because the expensive part is the stat call and doing it once is what keeps a three million file scan near two minutes.
- Progress streams to the interface over Server-Sent Events and the walk stops as soon as the client disconnects.
- Fast mode skips the churn directories the Cleanup view already owns and reports how many it skipped, so nothing is silently omitted.
- File sizes use blocks actually on disk, so sparse files and iCloud placeholders are never overcounted.
- Memory page size is read from vm_stat rather than assumed, which is what makes the Intel readings correct as well as the Apple Silicon ones.
- Scan results are cached in the server process, so reloading the interface restores the last scan instead of repeating it.

### Security

- No dependencies at all: no runtime packages, no development packages, no lockfile, nothing fetched from a registry.
- No outbound network path exists in the server. The socket binds to loopback only.
- Pages are served with a Content Security Policy that forbids every off-origin script, style, image, font and connection.
- No shell is ever spawned. Commands run with an argument array, so a filename cannot become a command.
- Mutating requests require a custom header and a same-origin check, so no other page in the browser can drive the tool.
- Continuous integration fails the build if a non-builtin import, an outbound network call, a shell invocation or a non-loopback bind is ever introduced.

### Verified on this release

- 118 automated tests across unit, filesystem, live-server and real-machine suites; 92.6% line coverage, 78.0% branch coverage and 88.6% function coverage of the library code, enforced by the build and independent of what happens to be installed on the machine running them.
- Continuous integration runs on macOS against Node 20, 22 and 24, builds the application bundle and the disk image on every push, mounts the image to check what a user would actually receive, verifies the signature and the checksum, and keeps the build available for download for fourteen days.
- The release pipeline refuses to publish a disk image whose application is missing either the arm64 or the x86_64 slice.

### Known limitations

- Some folders such as Mail storage and Photos internals require Full Disk Access; without it they are skipped without being counted. (Fixed in 1.0.1, which reports them.)
- iCloud Drive is deliberately excluded, because placeholder files would report sizes that are not actually on the disk.
- Emptying the Trash erases everything in it, not only what MacPuffin put there.
- The Intel slice is built and verified in continuous integration but has not yet been run on physical Intel hardware.
