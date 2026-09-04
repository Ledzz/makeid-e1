# AGENTS.md — working on makeid-e1

Guidance for coding agents (and humans) touching this repository.

## What this is

A static, zero-runtime-dependency web app that prints labels on a **MakeID E1** BLE label
printer via Web Bluetooth. The wire protocol was reverse-engineered from the MakeID-Life Android
APK and is documented in `docs/PROTOCOL.md`. The app is deployed to GitHub Pages
(<https://ledzz.github.io/makeid-e1/>) by `.github/workflows/deploy.yml` on every push to `main`.

## Hard rules

1. **Never invent protocol bytes.** Every byte value, offset or bit field in `src/printer/` must be
   traceable to `docs/PROTOCOL.md`, which in turn tags each claim `CONFIRMED` (bytecode),
   `HARDWARE-CONFIRMED` (tested on the printer), `ASSUMED` or `TODO`. If you add a claim, tag it.
   When jadx output shows an `if/else` with identical branches, check the smali; jadx got the
   `0x1B` length field wrong once already (§8 of the doc).
2. **Zero runtime dependencies.** `package.json` has only `vite` and `typescript` as dev
   dependencies. Do not add packages (including test frameworks or `@types/*`) without asking the
   repository owner first. Web Bluetooth types are hand-written in `src/types/web-bluetooth.d.ts`.
3. **`src/printer/` has no DOM access.** It may use `navigator.bluetooth`, typed arrays,
   `TextDecoder`, timers; nothing else from the browser. UI code lives in `src/ui/`.
4. **Tests must pass**: `npm test` runs `node --test` with Node's built-in TypeScript stripping,
   so test files and everything they import must use *erasable* TypeScript only (no `enum`, no
   parameter properties, no namespaces). `tsconfig.json` enforces `erasableSyntaxOnly`.
5. Keep the user-facing UI plain. Technical detail (hex, attributes, frame dumps) belongs in the
   collapsed "Advanced & diagnostics" panel.
6. **The phone is the primary target** (Chrome on Android is the only mobile browser with Web
   Bluetooth). Keep tap targets at 44 px and control fonts at 16 px (smaller fonts make iOS zoom),
   never let the page scroll horizontally — wide previews scroll inside `.preview-wrap` — and keep
   the print controls in the sticky `.actions` bar. The phone rules live in the
   `@media (max-width: 760px)` block at the end of `src/style.css`.

## Layout

```
docs/PROTOCOL.md            protocol reference; read §0, §6, §8, §11, §12 first
src/printer/frames.ts       frame builders, status parser, response classification, constants
src/printer/checksum.ts     two's-complement byte-sum checksum
src/printer/lzo1x.ts        LZO1X-1 compressor + decompressor (tests only for the latter)
src/printer/raster.ts       bitmap -> 1 bpp rows, rotation, head placement, banding, dithering
src/printer/job.ts          pure planner: label image + attributes -> ordered frame list
src/printer/client.ts       PrinterClient: connect-time query, heartbeat, print loop, timeouts
src/printer/webbluetooth.ts GATT transport, service discovery, chunked writes, reconnect
src/printer/reassembler.ts  notification reassembly ("##" strip, "**", length byte)
src/printer/transport.ts    Transport interface, DryRunTransport, chunkFrame
src/printer/__tests__/      node:test unit tests
src/ui/editor.ts            text -> canvas -> MonoImage at 203 dpi
src/ui/app.ts               all UI wiring; src/ui/storage.ts = localStorage persistence
apk/                        MakeID-Life APKs (gitignored); 2.2.0 is the one with E1 support
reverse/                    jadx / apktool output (gitignored, regenerate on demand)
```

## Commands

```bash
npm install
npm run dev          # Vite on http://localhost:5173 (Web Bluetooth needs localhost or HTTPS)
npm test             # unit tests (node --test, no extra deps)
npm run build        # tsc --noEmit + vite build -> dist/
```

Regenerate the decompiled sources when you need to check the SDK:

```bash
jadx -d reverse/jadx-2.2.0 --no-res apk/MakeID-Life_2.2.0_APKPure.apk
apktool d -f --no-res -o reverse/apktool-2.2.0 apk/MakeID-Life_2.2.0_APKPure.apk   # smali
```

Key SDK classes: `com.wewin.wewinprinter_api.printer.OperateNewProtocolPrinterRunnable`
(print loop, `0x1B` frame), `wewinPrinterOperateHelper` (checksum, status parsing, attribute
query), `CreateNewProtocolArray` (raster), `wewinprinter_connect.bluetooth.BluetoothConnect_BLE`
(transport), `com.wewin.house_print.service.PrinterManagerService` (app-side routing by name).

## Protocol facts you will need most often

* Frames: `66 lenLo lenHi cmd payload… ck`; `ck = (-Σ preceding bytes) & 0xFF`.
* `66 06 00 10 ss ck`: status/handshake (ss 0), pause (1), resume (2), cancel (3). The response is
  a 44-byte status frame on the E1; bytes 36-42 carry protocol version, position, byte-swap flag,
  head width in bytes and rows per band. Always take those from the printer.
* `0x1B` band: bytes 11-12 are the **label length along the feed**; the E1 auto-cuts there. The
  cut-type bits do not make it cut between copies; per-copy cutting is done by sending one job per
  copy (see `App.printJob`).
* Raster: 1 bpp, MSB first, rotate the horizontal label 90° cw, centre on the head, split into
  bands of `maxPrintRows`, LZO1X-1 each band (raw stream, ends `11 00 00`).
* Observed E1 (fw V1.0_230106.1): service `ABF0`, write `ABF1` without response, notify `ABF2`;
  12-byte head (96 dots), 170 rows/band, no byte swap, 203 dpi, has cutter.

## Verifying changes

* Driver changes: add or adjust a test in `src/printer/__tests__/`; `npm test` and `npm run build`
  must be green.
* UI changes: run `npm run dev`, keep "Test mode" (Advanced panel) on, use "Dump frame plan" to
  inspect what would be sent. Real prints need a physical E1 and Chrome/Edge.
* If the printer misbehaves, capture the console text (Advanced → Copy) — it contains every TX
  frame and RX notification in hex and is the primary debugging artefact.

## Commit and deploy

Commit to `main` and push; the Pages workflow runs tests, builds and deploys. Do not commit
`apk/*.apk`, `reverse/`, `dist/` or `node_modules/` (all gitignored).
