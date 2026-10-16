# Appearance (light and dark themes)

The whole app has a light and a dark theme. By default it follows the clock on the reader's own
device, and anyone can pin either theme from the switch beside the Polaris wordmark.

## The rule

- **Automatic (default)** — 07:00 to 19:00 local time resolves to the light theme; everything else
  resolves to the dark theme. "Local" means the clock and time zone of the computer or phone showing
  the page. The server never decides, and the time zone is never guessed from an IP address.
- Automatic mode is re-checked at the coming 07:00/19:00 boundary and at least once a minute, and it
  re-resolves immediately when a tab is focused, becomes visible again or is restored from the
  back/forward cache. A laptop that slept through 19:00 therefore wakes up dark.
- **Light / Dark** — a manual choice applies at once and keeps applying, including across the
  07:00/19:00 boundary. Nothing switches underneath the reader; the clock only takes over again after
  choosing Automatic.
- The only difference between the themes is colour. Layout, page width, spacing, uploaded images,
  platform brand colours and exported files are identical.

## Where the switch is

The trigger sits in the top right of the sidebar, on the Polaris wordmark row, on the workspace,
the sign-in page and the social-connection result page. It opens a small menu with three options:

| Option | Meaning |
| --- | --- |
| Automatic | Follow the device clock. Shown with the window it uses, the detected time zone, and a check mark while active |
| Light | Always light |
| Dark | Always dark |

The trigger's glyph reflects what is on screen right now (sun or moon), and a small dot marks
automatic mode. Arrow keys move through the options, Escape closes the menu and returns focus to the
trigger, and every label is translated into the four interface languages.

## What follows the theme

The switch covers the whole system: the sidebar and top bar, Overview, the Posts list and editor,
the AI workspace (import, references, assets, export, settings), the accounts and members panels,
dialogs, drawers, toasts and the standalone sign-in and authorisation pages.

Two deliberate exceptions:

- **The simulated social post keeps its platform palette.** The preview above a real platform card
  stays light with the network's own colours in both themes; the frame and toolbar around it follow
  the theme. A dark post preview would misrepresent what the network renders.
- **Status colours keep their meaning.** Success, warning and danger keep green/amber/red hues in
  both themes; only their surfaces and text lightness change so they stay readable.

## Preference storage

The choice is kept in the browser under `polaris-theme-mode` (`auto`, `light` or `dark`). It is a
per-browser, per-origin preference: it survives reloads, sign-in and sign-out, and is not shared
between devices or accounts. If browser storage is blocked or the stored value is unreadable, the
app silently falls back to automatic. Another tab of the same site that changes the mode updates
this one as well.

## How it is built

- `src/lib/theme.ts` holds the rules as pure functions (window, next boundary, storage parsing) plus
  the fixed pre-paint script.
- `src/app/layout.tsx` renders that script in `<head>`, so `html[data-theme]` is correct before the
  body is painted. A dark-mode visitor never sees a white flash, and `data-theme-mode` records
  whether the theme is automatic or pinned.
- `src/components/ThemeProvider.tsx` keeps the two values in step afterwards: the timers, focus and
  visibility listeners, and the cross-tab listener all live here. It never remounts the page, so an
  open editor, an unsaved draft or a running generation is untouched by a theme change.
- `src/components/ThemeToggle.tsx` is the switch. The trigger's glyph is chosen by CSS from the root
  attributes, so it is right on the first paint with nothing to hydrate.
- `src/app/globals.css` defines the palette twice, in `:root` / `html[data-theme="light"]` and
  `html[data-theme="dark"]`. Components and the older aliases (`--ink`, `--line`, `--paper`,
  `--white`, `--navy`) all resolve to those tokens, so a new component only has to pick the right
  token instead of adding another theme override.

## Verifying it

```sh
node scripts/test-theme.mjs                                  # logic only
TEST_BASE_URL=http://localhost:3002 node scripts/test-theme.mjs   # adds the browser checks
```

The script covers the 06:59/07:00/18:59/19:00 boundaries, the cross-midnight wait, invalid stored
values, agreement between the pre-paint script and the runtime for all 24 hours, a night-time first
paint, pinning a theme across the boundary and across a reload, returning to automatic, Escape and
focus handling, cross-tab sync, the phone-width rail and the absence of hydration warnings.

The browser section needs a running server (`npm run dev` or a production build) and Playwright's
Chromium, or an installed Chrome as a fallback.
