# Cove

Vertical tabs for Chrome, in the side panel: spaces, pinned tabs that remember their home URL,
folders, Essentials shared across every space, Peek for opening links without losing your place,
a search launcher, and an archive of closed tabs you can bring back.

Search, folders and the archive build on a contribution by Julio Orozco
([drewcoble/cove#1](https://github.com/drewcoble/cove/pull/1)).

## Install

1. Turn off any other extension that manages tab groups or vertical tabs; they'd fight over the
   same groups.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the Cove toolbar icon to open the sidebar. To put it on the left, open Chrome Settings →
   Appearance → Side panel → **Show on left**.

On first run, existing tab groups become spaces (by title) and existing Chrome-pinned tabs become
Essentials.

### Moving a setup between installs

Settings (the sliders icon) → **Export setup…** saves your spaces, pinned tabs, Essentials and
settings to a JSON file. **Import setup…** in another install replaces its setup with the file's,
then re-attaches already-open tabs to their pins by URL. Chrome ties an unpacked extension's
storage to its folder, so export before moving or renaming the folder, and import afterwards.

## How it maps onto Chrome

| Cove            | Chrome backing                                                            |
| --------------- | ------------------------------------------------------------------------- |
| Space           | One tab group per window, titled with the space name, in the space color  |
| Essentials      | Chrome-pinned tabs (shared across spaces, never grouped)                  |
| Pinned tab      | A saved entry in the space, bound to a live tab while it's open           |
| Folder          | Sidebar-only grouping of a space's pinned tabs (nested); no Chrome change |

Because each space is a group, space-mates stay contiguous in the tab strip. Inactive spaces are
collapsed by default, so the strip only shows the current space (you can turn that off in settings).

## Behaviour

- **Closing a tab stays in the space.** When you close the active tab (Cmd+W, the strip, or the
  sidebar), the next tab is the most recently used tab *in the same space*. Closing the last tab
  in a space opens a New Tab there. Closing an Essential returns you to the current space.
- **Pinned names stick.** A renamed pinned tab or Essential always shows your name, wherever it has
  navigated. When it drifts from its pinned URL, the row shows `icon / Name`.
- **Pinned tabs and Essentials go home.** Click one to switch to it. Click it again while it's
  active and drifted to send it back to its pinned URL. Hovering the favicon of a drifted pinned
  row also shows a reset button. Redirects right after opening (e.g. `gmail.com` →
  `mail.google.com/mail/u/0`) are remembered as aliases, so they don't count as drift.
- Closing a pinned tab or Essential only unloads it; it stays in the sidebar.

## Using it

- **Drag & drop:** tab → Essentials grid or pinned list to pin it; pins reorder within or between
  those areas; a pin dragged into the tab list becomes a normal tab; anything dropped on a space
  dot in the bottom bar moves to that space.
- **Right-click** tabs, pins, Essentials and spaces for everything else (rename, edit pinned URL,
  replace pinned URL with current, move to space, unload, and so on).
- **Spaces:** click the dots in the bottom bar, swipe horizontally on a trackpad, or use
  `Ctrl+Shift+←/→` on macOS (`Alt+Shift+←/→` elsewhere). Double-click the space name to rename it.
  Renaming the tab group in Chrome's strip also renames the space.
- **Essentials grid** sizes itself: up to 3 on one row, 4–10 split over two rows (3/2, 3/3, 4/3 …
  5/5), then rows of 5. The final row stretches to fill the sidebar.
- **Peek:** Option-click a link, or right-click → *Open link in Peek*, to open it in a floating
  window centered over Chrome. Esc, ✕, or clicking back into the main window closes it; ⤢ or ⌘↩
  opens it as a tab in your current space. It's a popup window rather than an in-page overlay, so
  logged-in sites work and sites that refuse to be embedded still open. Option-click normally
  downloads a link in Chrome; you can turn Peek's Option-click off in settings.
  In full screen, macOS would put a new window on its own desktop, so Peek opens in Chrome's split
  view beside the tab you came from instead (Chrome 155+). ✕ / Esc closes it and the original tab
  goes back to full width; ⤢ / ⌘↩ keeps it as a normal tab in your current space. A setting uses
  split view outside full screen too. If the tab is already in a split you made, Peek falls back
  to a temporary tab that closes back to where you were.
- **Links from Essentials open regular tabs in the current space**, preserving the Essential.
  Same-site navigation stays in place, and Command-click opens a background tab. Option-click
  still explicitly opens Peek. Links arriving from other apps also remain regular tabs.
- Middle-click closes a tab or unloads a pin. **Clear** on the divider closes the space’s other unpinned tabs, keeping the tab you are viewing.
- **Jump to a space by number:** "Go to space 1–9" commands exist but have no default keys
  (Chrome lets an extension suggest only 4). Bind them yourself at `chrome://extensions/shortcuts`,
  e.g. ⌃1, ⌃2, ⌃3. Hovering a space dot shows its shortcut once it's bound.
- **Search (⌘K):** press the search shortcut (or the magnifier at the top of the sidebar) to
  search the current space’s pinned tabs, shared Essentials, the archive and recent history, or type
  a URL or a web search. ↑/↓ and ↵ to pick; type `>` for commands (new folder, view archive,
  undo last close); Esc closes. Search appears over the current page; on pages Chrome doesn't let
  extensions touch (`chrome://` pages, the Web Store, PDFs) it opens as a temporary tab instead.
  It only runs when you open it, so sites keep their own ⌘K. Results are ranked by what you typed
  first, then by how often and how recently you visit pages and what you picked before for the
  same search; turn history off in settings, or forget remembered searches there.
  Ordinary open tabs are excluded as a result category. Web search stays in row two when a
  matching destination comes first; four rows are visible and more results scroll. Open pins
  show **Switch to tab** and activate the saved pin, including pins inside collapsed folders.
- **Folders:** right-click the space name → *New folder…*, or drag a tab or pinned tab onto the
  middle of a folder. Folders nest; right-click one to rename it, add a subfolder, open all its
  tabs, move it, or remove it (its pinned tabs and subfolders move up a level). Opening a pinned
  tab expands the folders above it.
- **Tab trees:** tabs opened from links nest beneath their source. Native New Tabs (Command/Ctrl+T)
  stay at the top level after a search or URL entry. Collapse a branch with its disclosure arrow;
  selecting a hidden child reveals its ancestors. Drag onto the middle/right of a tab to reparent
  it, or use **New child tab** / **Move out of parent tab** in its menu. Closing a parent promotes
  its children one level and keeps them open. Children of folder pins stay under their pin;
  Essential children appear under a per-space “From …” header. Links opened by other apps remain
  top-level tabs even when Chrome supplies an opener ID. Tree layout and explicit detach
  choices survive extension reloads for surviving tabs. Relationships are restored only from
  Cove’s saved tree; an opener ID alone is never used to infer a parent.
- **Archive:** tabs you close are kept (the last 500, on this computer, sign-in parameters
  stripped) so you can find and reopen them: the archive button at the bottom of the sidebar, or
  *View archive* in search. Closing from the sidebar or **Clear** shows an Undo toast, and *Reopen
  the last closed tab* (⌥⇧Z) brings back the last close in that window. Pinned tabs, Essentials,
  Peeks, closed windows and deleted spaces aren't archived. Turn it off or clear it in settings.
- **Copy current URL:** bind "Copy the current tab URL" to ⌘⇧C at `chrome://extensions/shortcuts`.
  Chrome won't assign it automatically because ⌘⇧C is also DevTools' Inspect shortcut. A ✓
  flashes on the toolbar icon, and the sidebar shows "Copied URL" if it's open.
- Shortcuts can be changed at `chrome://extensions/shortcuts`. There's also an unbound
  "reset pinned tab" command you can assign. See the recommended set below.

## Recommended keyboard shortcuts

Chrome only pre-assigns a few of these, so set them at `chrome://extensions/shortcuts` (macOS
keys shown; leave **Scope** as *In Chrome*).

| Command                                                  | Shortcut  |
| -------------------------------------------------------- | --------- |
| Activate the extension (opens the sidebar)               | ⌘S        |
| Search tabs, pins, spaces, history and commands          | ⌘K        |
| Reopen the last closed tab (or cleared batch)            | ⌥⇧Z       |
| Copy the current tab URL                                 | ⇧⌘C       |
| Switch to the next space                                 | ⇧⌘→       |
| Switch to the previous space                             | ⇧⌘←       |
| Go to space 1 … 9                                        | ⌃1 … ⌃9   |
| Send the current pinned tab / Essential back to its pinned URL | not set |

Some of these replace Chrome's own shortcuts while Chrome is focused: ⌘S (Save Page As), ⇧⌘C
(DevTools' Inspect), and ⇧⌘←/⇧⌘→ (selecting to the start/end of a line in text fields). ⌃1–⌃9 only
reach Chrome if macOS's "Switch to Desktop" shortcuts are off (System Settings → Keyboard →
Keyboard Shortcuts → Mission Control).

## Limits

- Peek needs access to all sites so it can catch Option-clicks, and search needs it to show its
  panel over a page. Tabs that were already open need a reload before Option-click works.
- Search asks to read your browsing history so it can suggest pages you've visited. History is
  only read inside the extension's own search page and never sent to websites; turn it off in
  settings to stop using it.
- Opening a floating Peek as a tab reloads the page there, because Chrome doesn't allow moving a
  tab out of a popup window.
- Chrome's horizontal tab strip can't be hidden by an extension. Collapsing inactive spaces keeps
  it tidy.
- Chrome briefly selects its own choice before the extension switches to the same-space tab when
  you close with Cmd+W, so you may see a one-frame flicker. Closing from the sidebar doesn't
  flicker, because the successor is picked before the tab closes.
- Pins are re-bound to restored tabs by URL after a browser restart. If two restored tabs share a
  pinned tab’s URL, the first one wins. Exact saved URLs and hash routes are matched before
  broader redirect aliases, so distinct app routes keep their own pins.

## Tests

Additional regression coverage for tab trees, search preferences, Clear, and pinned URL menus:

```bash
node test/search-ranking.mjs
node test/tab-tree.mjs
node test/harness.mjs . test/tab-tree.js test/tab-tree-reload.js
node test/harness.mjs . test/tab-tree-newtab.js test/tab-tree-newtab-reload.js
node test/harness.mjs . test/external-link-tree.js test/external-link-tree-reload.js
node test/harness.mjs . test/launcher-regressions.mjs
node test/harness.mjs . test/clear-keeps-active.js
node test/harness.mjs . test/pin-url-menu.js
node test/harness.mjs . test/essential-links.mjs
node test/essential-reload.mjs .
node test/harness.mjs . test/reconcile-upgrade.js test/reconcile-upgrade-reload.js
```

`test/` drives a real headless Chrome with a throwaway profile, so it never touches your profile:

```bash
node test/harness.mjs . test/scenarios.js test/phase2.js
```

`phase2.js` reloads the extension, which wipes session state the same way a browser restart does,
and checks that spaces and pins are rebuilt correctly.

Peek with real Option-clicks and key presses:

```bash
node test/peek-input.mjs .
```

Search over real pages (what the page can and can't see, results, the restricted-page
fallback, token checks):

```bash
node test/search.mjs .
```

Folders, import repair and the archive, then the 500-entry cap across a reload:

```bash
node test/harness.mjs . test/features.js
node test/harness.mjs . test/archive-cap.js test/archive-cap-2.js
```

Export → fresh install → import:

```bash
node test/harness.mjs . test/migrate-export.js test/migrate-import.js
```

Smaller checks, each run as `node test/harness.mjs . test/<file>`: `essentials-layout.js` (grid
rows for 1–11 Essentials), `popover-enter.js` (Enter in one popup must not re-run an earlier
popup's action) and `security.js` (tokens kept out of storage and exports, and web pages unable to
reach the clipboard, other windows' Peeks or your saved setup).

## License

[MIT](LICENSE)
