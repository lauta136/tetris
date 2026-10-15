# Tetris

Modern Tetris as a progressive web app. On-screen buttons built for thumbs,
plus swipe gestures. Installs to the iPhone home screen and plays fully
offline.

Vanilla JavaScript and Canvas — no dependencies, no build step, no framework.

## Play

**<https://lauta136.github.io/tetris/>**

On an iPhone: open that link in **Safari**, tap **Share → Add to Home Screen**.
It then launches fullscreen from an icon and works with no connection.

## Features

| Guideline feature | Notes |
| --- | --- |
| 7-bag randomiser | One of each piece per bag — no droughts |
| SRS rotation | Full JLSTZ and I wall-kick tables |
| Hold slot | Park a piece, swap it back once per drop |
| Ghost piece | Outline showing where the piece will land |
| Next queue | 3 pieces deep |
| Lock delay | 500 ms with up to 15 move resets |
| T-spins | 3-corner rule, mini vs full, plus the final-kick promotion |
| Back-to-back / combos / perfect clears | Full Guideline scoring table |
| Gravity curve | `(0.8 - (level-1) * 0.007) ^ (level-1)` |

Score translates to `base × level`, with `×1.5` for back-to-back difficult
clears and `50 × combo` per consecutive clear.

## Controls

On-screen buttons, laid out for two thumbs:

```
 ◀     ▶    ↺      ↻        row 1: move, rotate
Left  Right CCW    CW
 ▼     ▼         Hold       row 2: drop, hold
Soft  Hard
```

- **Hold** a direction to auto-repeat. 165 ms delay, then 42 ms per step.
- **Left / Right** cancels the opposite direction's repeat.
- Swipes also work on the playfield: tap to rotate, drag sideways to move,
  drag down to soft drop, flick down to hard drop, swipe up to hold.
- Desktop keyboard: arrows, `Space` hard drop, `X`/`Z` rotate, `C` hold,
  `P` pause.

No haptics: iOS Safari does not expose the Vibration API, so buttons give
visual press feedback instead.

Passing your previous record flashes a **New Best** pill and turns the score
teal for the rest of the run.

## Run locally

The service worker needs a secure context, so `file://` will not register it.
Any static server works:

```sh
cd tetris
python3 -m http.server 8000
```

Then open <http://localhost:8000>. To test on a phone over Wi-Fi, use the
Mac's LAN address (`http://<your-ip>:8000`) — everything except offline mode
works there, because LAN HTTP is not a secure context.

## Layout

```
index.html              entry shell (GitHub Pages serves this at the root)
tetris.js               the game — all logic, rendering and input
style.css               clean modern dark theme
sw.js                   service worker, cache-first offline shell
manifest.webmanifest    PWA manifest
icons/                  generated app icons
tools/make_icons.py     regenerates the icons (stdlib only)
tools/selftest.html     engine test suite, runs in the browser
tools/frame.html        renders the app at an exact device size for screenshots
```

Regenerate icons with:

```sh
python3 tools/make_icons.py
```

## Tests

`tools/selftest.html` drives the real engine through 47 assertions: the 7-bag
randomiser, SRS wall kicks (including a rotation that must fail), lock-delay
resets, T-spin detection (full, mini, and the final-kick promotion), hold,
scoring for singles / Tetris / back-to-back / combos / perfect clears, hard
drop points, top-out, and canvas rendering.

It loads the real `index.html` markup and uses the `?debug=1` hook that
`tetris.js` exposes (which is otherwise absent in production). Run it with the
page's own output, or read the results from the console:

```sh
python3 -m http.server 8777
```

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --dump-dom --virtual-time-budget=25000 --enable-logging=stderr --v=0 \
  "http://localhost:8777/tools/selftest.html?debug=1" 2>&1 | grep '__T|'
```

To eyeball the layout at a specific device size (Chrome's `--window-size` is
ignored for layout in headless mode, but an iframe gets a real viewport):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --window-size=390,844 --virtual-time-budget=9000 --screenshot=shot.png \
  "http://localhost:8777/tools/frame.html?w=390&h=844"
```

## Deploy

GitHub Pages, branch `main`, root folder. After changing any cached asset,
bump `CACHE` in `sw.js` (`tetris-v1` → `tetris-v2`) so clients pick it up.
