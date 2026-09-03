# MakeID E1 web printer

A static, zero-runtime-dependency web app that prints labels on a **MakeID E1** BLE label printer
from the browser via Web Bluetooth. The protocol was reverse-engineered from the MakeID-Life
Android app; see [docs/PROTOCOL.md](docs/PROTOCOL.md) for the full write-up, including which
claims are confirmed in the bytecode and which still need hardware verification.

> Status: **prints on a real E1** (firmware V1.0_230106.1, verified 2026-09-04). A test mode
> that only logs frames is available under "Advanced".

## Features

* Device picker (`requestDevice` with `namePrefix: "E1"`, optional "show all devices"),
  connection status with battery, auto-reconnect on `gattserverdisconnected`, and automatic
  reconnection to the remembered printer on page load (Chrome's `getDevices()` +
  `watchAdvertisements()`; falls back to the Connect button where unsupported).
* Recent labels: every label actually printed is kept (last 20) for one-click reprint; all
  editor and printer settings persist in `localStorage`.
* Test mode (under Advanced) previews and dumps frames without transmitting.
* Canvas label editor: text (multi-line), font size, monospace font, alignment, 90° text
  rotation, tape width (9/12/16 mm), auto or fixed label length, copies, density, tape mode
  (continuous / die-cut), 180° flip of the printed orientation.
* 1:1 preview in printer dots plus the "wire" image exactly as it is sent (head width × length).
* Batch printing: paste one label per line, print the queue.
* Diagnostics (hex console of every frame and notify, wire image, printer attributes) live in a
  collapsible "Advanced" panel.
* Protocol driver in `src/printer/` with no DOM access; unit tests for the checksum, the bitmap
  encoder, the LZO1X-1 compressor, the frame builders/parsers and the notify reassembler.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (Web Bluetooth works on localhost)
npm test           # node --test, no extra dependencies
npm run build      # typecheck + vite build -> dist/
```

Web Bluetooth needs Chrome or Edge (desktop or Android) on HTTPS or `localhost`, and the
"Connect" button must be pressed by the user (browser requirement for `requestDevice`).

## Deploy to GitHub Pages

The Vite config uses `base: './'`, so the `dist/` folder works from any Pages path.
`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`
(enable "GitHub Actions" as the Pages source in the repository settings).

## Layout

```
docs/PROTOCOL.md          protocol reference (CONFIRMED / ASSUMED / TODO)
src/printer/              driver: frames, checksum, LZO1X, raster, job planner, client, BLE transport
src/printer/__tests__/    node:test unit tests
src/ui/                   editor, console, app wiring (DOM)
apk/                      MakeID-Life APKs analysed (1.8.6 and 2.2.0)
```

## Verifying against the printer

Follow the TODO list in `docs/PROTOCOL.md` §12. The first live steps are: connect, read the
status/attribute response (head width, band rows, protocol version), then print a tiny label in
live mode with the default 20-byte chunks.
