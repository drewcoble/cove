# Cove

Zen-browser-style vertical tabs for Chrome: spaces, per-space pinned tabs, and Essentials shared
across spaces, all in Chrome's side panel.

## Install

1. Turn off Arcify (both extensions manage tab groups and would fight each other).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the Cove toolbar icon to open the sidebar. To put it on the left like Zen, open
   Chrome Settings → Appearance → Side panel → **Show on left**.

On first run, existing tab groups are adopted as spaces by title, and existing Chrome-pinned tabs
become Essentials. That brings Arcify's `local` / `dev` / `beta` groups across automatically.

## How it maps onto Chrome

| Zen concept     | Chrome backing                                                            |
| --------------- | ------------------------------------------------------------------------- |
| Space           | One tab group per window, titled with the space name, in the space color  |
| Essentials      | Chrome-pinned tabs (shared across spaces, never grouped)                  |
| Pinned tab      | A saved entry in the space, bound to a live tab while it's open           |

Because each space is a group, space-mates stay contiguous in the tab strip. Inactive spaces are
collapsed by default, so the strip only shows the current space (you can turn that off in settings).

## Behaviour (the Arcify gaps)

- **Closing a tab stays in the space.** When you close the active tab (Cmd+W, the strip, or the
  sidebar), the next tab is the most recently used tab *in the same space*. Closing the last tab
  in a space opens a New Tab there. Closing an Essential returns you to the current space.
- **Pinned names stick.** A renamed pinned tab or Essential always shows your name, wherever it has
  navigated. When it drifts from its pinned URL, the row shows `icon / Name`, like Zen.
- **Pinned tabs and Essentials go home.** Click one to switch to it. Click it again while it's
  active and drifted to send it back to its pinned URL. Hovering the favicon of a drifted pinned
  row also shows a reset button. Redirects right after opening (e.g. `gmail.com` →
  `mail.google.com/mail/u/0`) are remembered as aliases, so they don't count as drift.
- Closing a pinned tab or Essential only unloads it; it stays in the sidebar.

## Using it

- **New Tab:** `Cmd+T` on macOS / `Ctrl+T` elsewhere, Chrome's + button, and the sidebar's
  **New Tab** button use the browser's normal New Tab page. This extension does not override
  it. Chrome shows its standard Google New Tab; Helium uses its native New Tab page.
- **Floating search:** press `Cmd+K` on macOS / `Ctrl+K` elsewhere on a web page to open
  a centered search panel over that page. The page stays visible behind it. Search tabs,
  pins and spaces; type a URL/web search to open a new tab in the current space, or type
  `>` for commands. The panel includes folder creation, archive search and undo.
  Use ↑/↓ and Enter to choose. Esc clears your query first, then dismisses the panel;
  clicking outside also dismisses it and returns focus to the page. Chrome internal
  pages and other pages that block injection open a dedicated search page instead.
- **Sidebar command bar:** click **Search tabs or run a command**. With the sidebar
  focused, `Cmd/Ctrl+K` also works there.
  Search tabs and saved pins across spaces, switch spaces, move or pin the current tab,
  create a folder, view the archive, or enter a URL/search query to open a new tab.
  Use ↑/↓ and Enter to select a result, and Esc to dismiss. Chrome shortcut conflicts
  can be resolved at `chrome://extensions/shortcuts`.
  If Chrome retains the previous Option+K binding after updating, set **Open floating
  search over the current page** to `Command+K` there. Existing web pages can be reloaded
  to install the new page shortcut; Chrome's registered command also injects it on demand.
- **Folders:** choose **New folder…** from a space's menu or the command bar. Drag a tab
  or pin onto a folder to put it there. Right-click a pin to move it into or out of a
  folder. Click a folder to collapse it; right-click it to rename, create a subfolder,
  move it into another folder, open all its tabs, or remove it. Removing a folder keeps
  its pins and child folders. Selecting a pinned tab expands all of its folder ancestors
  and scrolls the active row into view, including when selected through floating search or
  Chrome's tab strip. You can still collapse the folder manually until the tab is selected
  or navigated again. Moving a pin to another space clears its folder membership.
- **Archive and undo:** ordinary tabs closed from the sidebar or Chrome's tab strip go
  into the archive. **Clear** archives the space's other unpinned tabs as one batch, keeping the tab you are viewing. Click **Undo**
  in the notification, use **Undo last close** in the command bar/archive, or press
  `Alt+Shift+Z` (`Option+Shift+Z` on macOS) to restore the last batch from this window.
  The ↶ button at the bottom opens the searchable archive; click a result to restore it
  into its original space. If that space was deleted, it restores into the current space.
  Closing pins or Essentials still only unloads them.
- **Drag & drop:** tab → Essentials grid or pinned list to pin it; pins reorder within or between
  those areas; a pin dragged into the tab list becomes a normal tab; anything dropped on a space
  dot in the bottom bar moves to that space.
- **Right-click** tabs, pins, Essentials and spaces for everything else (rename, edit pinned URL,
  replace pinned URL with current, move to space, unload, and so on).
- **Spaces:** click the dots in the bottom bar, swipe horizontally on a trackpad, or use
  `Ctrl+Shift+←/→` on macOS (`Alt+Shift+←/→` elsewhere). Double-click the space name to rename it.
  Renaming the tab group in Chrome's strip also renames the space.
- **Peek (Zen's Glance):** Option-click a link, or right-click → *Open link in Peek*, to open it in
  a floating window centered over Chrome. Esc, ✕, or clicking back into the main window closes
  it; ⤢ or ⌘↩ opens it as a tab in your current space. It's a popup window rather than an
  in-page overlay, so logged-in sites work and sites that refuse to be embedded still open.
  Option-click normally downloads a link in Chrome; you can turn Peek's Option-click off in settings.
  In full screen, macOS would put a new window on its own desktop, so Peek opens in Chrome's split
  view beside the tab you came from instead (Chrome 155+). ✕ / Esc closes it and the original tab
  goes back to full width; ⤢ / ⌘↩ keeps it as a normal tab in your current space. A setting uses
  split view outside full screen too. If the tab is already in a split you made, Peek falls back
  to a temporary tab that closes back to where you were.
- **Links from Essentials open in the current space.** Links to another site open as
  normal tabs while the Essential stays on its original page. Links that open a new tab
  (including background Cmd/Ctrl-clicks) join the current space as well. Same-site navigation,
  such as reading an email, stays in the Essential. Links arriving from other apps also stay
  regular tabs. Option-click still explicitly opens Peek.
- Middle-click closes a tab or unloads a pin. **Clear** on the divider archives the space's other unpinned tabs and keeps the current tab.
- **Jump to a space by number:** "Go to space 1–9" commands exist but have no default keys
  (Chrome lets an extension suggest only 4). Bind them yourself at `chrome://extensions/shortcuts`,
  e.g. ⌃1, ⌃2, ⌃3 like Zen. Hovering a space dot shows its shortcut once it's bound.
- **Copy current URL:** bind "Copy the current tab URL" to ⌘⇧C at `chrome://extensions/shortcuts`.
  Chrome won't assign it automatically because ⌘⇧C is also DevTools' Inspect shortcut. A ✓
  flashes on the toolbar icon, and the sidebar shows "Copied URL" if it's open.
- Shortcuts can be changed at `chrome://extensions/shortcuts`. There's also an unbound
  "reset pinned tab" command you can assign.

## Recommended keyboard shortcuts

Chrome only pre-assigns a few of these, so set them at `chrome://extensions/shortcuts` (macOS
keys shown; leave **Scope** as *In Chrome*).

| Command                                                  | Shortcut  |
| -------------------------------------------------------- | --------- |
| Activate the extension (opens the sidebar)               | ⌘S        |
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

- Floating search cannot be injected into browser internal pages or the Chrome Web Store.
  Command+K opens a standalone extension search page there; it does not replace normal
  New Tabs. Unused native New Tabs and standalone search pages are excluded from the archive.
- The archive keeps the most recent **500 tabs** locally across restarts. Restoration
  reopens saved URLs; it does not recover form contents, scroll position, or page history.
  Closing a whole window/browser, deleting a space, and dismissing Peek do not create
  archive entries. Undo targets this window's most recent remaining archive batch;
  the archive browser can restore entries from any window or previous session.
- Existing saved pins migrate automatically to the folder/archive format and stay at
  the top level of their spaces.
- Peek needs access to all sites so it can catch Option-clicks; that's the only reason the
  extension asks for it. Tabs that were already open need a reload before Option-click works.
- Opening a Peek as a tab reloads the page there, because Chrome doesn't allow moving a tab out
  of a popup window.

- Chrome's horizontal tab strip can't be hidden by an extension. Collapsing inactive spaces keeps
  it tidy.
- Chrome briefly selects its own choice before the extension switches to the same-space tab when
  you close with Cmd+W, so you may see a one-frame flicker. Closing from the sidebar doesn't
  flicker, because the successor is picked before the tab closes.
- Pins are re-bound to restored tabs by URL after a browser restart. If two restored tabs share a
  pinned tab's URL, the first one wins.

## Setup backup

Use **Export setup…** and **Import setup…** in Settings to move spaces, Essentials, pinned tabs, folders and settings between installations. Import keeps open tabs and the local archive. Sign-in parameters are stripped from stored URLs and exports.

## Tests

`test/` drives a real headless Chrome with a throwaway profile, so it never touches your profile:

```bash
node test/harness.mjs . test/scenarios.js test/phase2.js
node test/harness.mjs . test/organizer.js test/organizer-reload.js
node test/harness.mjs . test/migration.js test/migration-reload.js
node test/harness.mjs . test/newtab.mjs  # standalone search fallback
node test/harness.mjs . test/default-newtab-and-folders.mjs test/folder-reveal-reload.js
node test/harness.mjs . test/command-overlay.mjs
node test/harness.mjs . test/essential-links.mjs
node test/harness.mjs . test/security.js
node test/harness.mjs . test/migrate-export.js test/migrate-import.js
node test/harness.mjs . test/essentials-layout.js
node test/harness.mjs . test/popover-enter.js
```

Peek is also tested with real Option-clicks and key presses:

```bash
node test/peek-input.mjs .
```

`phase2.js` reloads the extension, which wipes session state the same way a browser restart does,
and checks that spaces and pins are rebuilt correctly.

## License

[MIT](LICENSE)
