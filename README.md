# Cove

Vertical tabs for Chrome, in the side panel: spaces, pinned tabs that remember their home URL,
Essentials shared across every space, and Peek for opening links without losing your place.

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
  5/5), then rows of 5.
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
- **Links from Essentials open in Peek**, so your inbox stays put behind it and closing the Peek
  brings you straight back. That covers links that would open a new tab, and links to a different
  site that would navigate the Essential away. Links within the same site (opening an email) and
  ⌘-clicks (background tabs) behave normally. You can turn this off in settings.
- Middle-click closes a tab or unloads a pin. **Clear** on the divider closes the space's unpinned tabs.
- **Jump to a space by number:** "Go to space 1–9" commands exist but have no default keys
  (Chrome lets an extension suggest only 4). Bind them yourself at `chrome://extensions/shortcuts`,
  e.g. ⌃1, ⌃2, ⌃3. Hovering a space dot shows its shortcut once it's bound.
- **Copy current URL:** bind "Copy the current tab URL" to ⌘⇧C at `chrome://extensions/shortcuts`.
  Chrome won't assign it automatically because ⌘⇧C is also DevTools' Inspect shortcut. A ✓
  flashes on the toolbar icon, and the sidebar shows "Copied URL" if it's open.
- Shortcuts can be changed at `chrome://extensions/shortcuts`. There's also an unbound
  "reset pinned tab" command you can assign.

## Limits

- Peek needs access to all sites so it can catch Option-clicks; that's the only reason the
  extension asks for it. Tabs that were already open need a reload before Option-click works.
- Opening a floating Peek as a tab reloads the page there, because Chrome doesn't allow moving a
  tab out of a popup window.
- Chrome's horizontal tab strip can't be hidden by an extension. Collapsing inactive spaces keeps
  it tidy.
- Chrome briefly selects its own choice before the extension switches to the same-space tab when
  you close with Cmd+W, so you may see a one-frame flicker. Closing from the sidebar doesn't
  flicker, because the successor is picked before the tab closes.
- Pins are re-bound to restored tabs by URL after a browser restart. If two restored tabs share a
  pinned tab's URL, the first one wins.

## Tests

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

Export → fresh install → import:

```bash
node test/harness.mjs . test/migrate-export.js test/migrate-import.js
```

Smaller checks, each run as `node test/harness.mjs . test/<file>`: `essentials-layout.js` (grid
rows for 1–11 Essentials) and `popover-enter.js` (Enter in one popup must not re-run an earlier
popup's action).
