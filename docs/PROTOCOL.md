# MakeID E1 — BLE Protocol Reference (static analysis)

Reverse-engineered from the **MakeID-Life** Android app
(`com.wewin.house_print_international`), versions **1.8.6** (`apk/MakeID-Life_1.8.6_APKPure.apk`,
Aug 2022) and **2.2.0** (`apk/MakeID-Life_2.2.0_APKPure.apk`, May 2025, fetched from APKPure
because 1.8.6 predates the E1). Decompiled with jadx 1.5.x and apktool 2.x. No BLE traffic was
captured; nothing here has been tested against hardware yet.

Every claim is tagged:

* **CONFIRMED** — traced in the decompiled bytecode (file:line references are to the jadx output of
  2.2.0 unless stated otherwise).
* **ASSUMED** — inferred from context, naming, or sibling models; must be verified on the printer.
* **TODO** — not present in the APK at all; needs a hardware measurement or a question to you.

---

## 0. Executive summary

* The app contains **two unrelated printer protocols**. Which one is used is decided purely by the
  BLE/BT **device-name prefix** (`PrinterManagerService.java:557-607`, 2.2.0):

  | Name prefix (lower-cased) | Protocol | Transport | Notes |
  |---|---|---|---|
  | `l1a`, `q1` | **PrintPP / "AiYin"** ESC/POS-derived (`10 FF …`, `1D 76 30`) | Classic Bluetooth SPP (RFCOMM) | Same family as the Fichero D11s write-up. See Appendix A. |
  | `e1`, `e1a`, `s1p`, `s1`, `c18`, `cs18`, `jingjing`, `l1s`, `l1h`, `l1c`, `l1e` | **wewin "new protocol"** (`66 LL LL CMD … CK`) | BLE GATT | **The E1 is here.** |
  | `m1`, `l1` | wewin new protocol | Classic SPP | same frames, different transport |

  The E1's theme is `THEME_KEY`; `StaticArgs.KEY = "e1"`, `KEY_AUTO = "e1a"`
  (`StaticArgs.java:102-103`). Its device name must start with `E1` for the app to accept it
  (`PrinterManagerService.java:845`, `PrintThemeChangeEvent.java:16`). **CONFIRMED**

* **1.8.6 does not know the E1 at all** (no `e1` prefix, no E1 theme, no E1 strings). Everything
  E1-specific below comes from 2.2.0. The wewin SDK itself (`com.wewin.wewinprinter_api`) is the
  same in both versions apart from cosmetic renames plus a few new features (firmware/entry upload).
  **CONFIRMED**

* Framing: `66 | len_lo | len_hi | cmd | payload… | checksum`, checksum = two's-complement of the
  byte sum (whole frame sums to 0 mod 256). Only **two commands matter** for printing:
  `0x10` (status / handshake / pause / resume / cancel) and `0x1B` (one band of LZO1X-compressed
  1-bpp raster). There is no separate "job start" / "job end" command; the job ends when the band
  whose *remaining-bands* counter is 0 has been acknowledged. **CONFIRMED**

* The print head width and the band height are **not constants in the app**: the printer reports
  them in its `0x10` status response (bytes 39-42) together with a protocol version, and the SDK
  only takes this path when the reported protocol version is ≥ 1.3. **CONFIRMED** (parsing) /
  **ASSUMED** (that the E1 reports ≥ 1.3 — if it doesn't, the SDK falls back to a legacy builder,
  see §9).

* Third-party SDKs: the wewin SDK is wewin's own (`com.wewin.wewinprinter_api`, Chongqing wewin /
  Jingranyouxu). The PrintPP SDK (`com.example.sdk.PrintPP`, version string `1.1.0_20190326`) is
  the AiYin/"Alison" printer SDK also found inside LuckPrinter-based apps (Fichero). MakeID's public
  GitHub SDK (`MakeID-Developer/label-print`) is a label *layout* SDK (Android/iOS/JS/HTTP) and its
  README documents no wire protocol; it was not useful for framing. **CONFIRMED**

* Native code: `libCode.so` (1.8.6 only) is stock zlib plus two JNI wrappers
  `Java_com_example_sdk_Code_code` = `compress()` and `…_decode` = `uncompress()`. It is used only
  by the PrintPP path (`1F 00` compressed-bitmap command for 300-dpi IP3xx models). Not a dead end,
  fully understood, and irrelevant to the E1. The 2.2.0 APKPure build ships no native libraries at
  all. **CONFIRMED**

---

## 1. Sources

| What | Where (jadx output of 2.2.0) |
|---|---|
| BLE transport, UUIDs, MTU, chunking, notify reassembly | `com/wewin/wewinprinter_connect/bluetooth/BluetoothConnect_BLE.java` |
| Connection state machine, heartbeat, attribute query | `com/wewin/wewinprinter_api/wewinPrinterConnectionHelper.java`, `wewinPrinterOperateHelper.java:3226-3430` (`CheckPrinterAttributeEvent`) |
| Frame builders, checksum, status parsing | `wewinPrinterOperateHelper.java` (`getCheckNum`, `operate10Check`, `parsePrinterStatus`, `doOperateCheckPrinterFirmware`) |
| Response classification | `com/wewin/wewinprinter_api/printer/wewinPrinterParsingProtocol.java` |
| Print sequence, `0x1B` / `0x1A` frames | `printer/OperateNewProtocolPrinterRunnable.java` |
| Model routing, head width defaults | `printer/wewinPrinterManager.java` |
| Raster encoding, banding, LZO | `printer/CreateNewProtocolArray.java:1225-1360`, `org/minilzo/common/{LZOUtil,MiniLZO}.java` |
| App-side parameters (E1 theme, density, cut type, clearance) | `com/wewin/house_print/service/PrinterManagerService.java`, `util/DeviceInfoUtils.java`, `util/DensityUtils.java`, `util/DBUtils.java`, `weight/print/StaticArgs.java` |
| PrintPP / AiYin path (Appendix A) | `com/example/sdk/{PrintPP,e,a,f,b}.java`, `com/wewin/WewinPrinterLibrary/ThirdSDK/AlisonPrinter/AlisonPrinterSDKUtils.java` |

Prior art used as template: <https://github.com/0xMH/fichero-printer/blob/main/docs/PROTOCOL.md>
(same PrintPP/AiYin family as Appendix A; **not** the E1's protocol).

---

## 2. BLE layer

### 2.1 Services and characteristics — CONFIRMED (`BluetoothConnect_BLE.java:43-51, 918-1030`)

The SDK looks for, in this order:

| Role | Service | Write char | Notify char | SDK name |
|---|---|---|---|---|
| "new printer" (preferred) | `0000ABF0-0000-1000-8000-00805F9B34FB` | `0000ABF1-…` | `0000ABF2-…` | `UUIDSTR_ESPRESSIF_NEW_*` (ESP32 firmware) |
| "old printer" | `49535343-FE7D-4AE5-8FA9-9FAFD205E455` | `49535343-8841-43F4-A8D4-ECBE34729BB3` | `49535343-1E4D-4BD9-BA61-23C647249616` | Microchip/ISSC transparent UART |
| OTA (firmware update only) | `1D14D6EE-FD63-4FA1-BFA4-8F47B42119F0` | `984227F3-34FC-4045-A5D0-2C581F81A153` (data) | `F7BF3564-FB6D-4E53-88A4-5E37E0326063` (control) | Microchip BM7x OTA |
| fallback | first service that has one characteristic with WRITE or WRITE_NO_RESPONSE **and** one with NOTIFY or INDICATE | prefers WRITE_NO_RESPONSE, else first writable | first NOTIFY/INDICATE | `findBluetoothGattServer` |

Also present in the string table but **not referenced by the BLE transport**: `0000FEE7`,
`0000FF10/FF11`, `0000FF80/FF82` (belong to the Tencent/umeng libraries), classic SPP
`00001101`. **CONFIRMED**

**TODO (hardware):** which of the two UART services the E1 actually exposes. Declare both in
`optionalServices`. The response-length parsing differs slightly between them (§2.4).

### 2.2 Notifications — CONFIRMED (`BluetoothConnect_BLE.java:865-900`)

`setCharacteristicNotification(true)` then write CCCD `00002902-…` with `ENABLE_NOTIFICATION_VALUE`
(`01 00`) when the characteristic has PROPERTY_NOTIFY, `ENABLE_INDICATION_VALUE` (`02 00`) when it
only has INDICATE. Connection is considered established in `onDescriptorWrite` (status 0).

### 2.3 Connect ordering and MTU — CONFIRMED (`BluetoothConnect_BLE.java:395, 484-515, 565-640, 742-790`)

1. `connectGatt(autoConnect=false, TRANSPORT_LE)`; app connect timeout 10 000 ms.
2. `discoverServices()`.
3. `requestMtu(n)`. The app asks for **512** if its "share" preference is on, otherwise **23**
   (`PrinterManagerService.java:584-591`); on Android > 33 the SDK caps the effective MTU at **64**.
   If `requestMtu` fails it retries with the default (64 on Android > 33, else max(writeMTU, 23)).
4. `onMtuChanged(mtu)` → chunk size `writeMTU = mtu − 3` (API ≤ 28), `mtu − 5` (API ≤ 31),
   `mtu − 6` (API > 31). Then characteristics are selected and notifications enabled.
5. `onDescriptorWrite` → "connected" callback → SDK waits **200 ms** and starts the attribute query
   (§5.1) and the 1 s heartbeat (§5.2).

So the known-good chunk sizes are **20 bytes** (MTU 23) and **58 bytes** (MTU 64). Web Bluetooth
cannot read the negotiated MTU; default the client to 20-byte chunks and make it configurable.
**ASSUMED:** the E1 accepts larger chunks (typical for ESP32 firmware) — verify.

### 2.4 Write path — CONFIRMED (`BluetoothConnect_BLE.java:1035-1160`)

* `SendData(frame, expectedLen)`: the frame is copied, split into `writeMTU`-byte chunks and each
  chunk is written with `writeCharacteristic()` using the characteristic's **default write type**
  (no `setWriteType` call on the data characteristic; only the OTA characteristic is forced to
  WRITE_TYPE_DEFAULT). So: with-response if the characteristic advertises WRITE, else
  without-response.
* Backpressure: `writeCharacteristic()` is retried every 10 ms (up to 1 s) until Android accepts it,
  which serialises chunks behind the previous write's completion. No inter-chunk delay otherwise.
* After the last chunk the SDK blocks in `readData()` until a complete response has been assembled
  or the read timeout expires. Read timeout: **10 000 ms** for `0x10` handshakes and `0x1B` band
  frames (`OperateNewProtocolPrinterRunnable.java:47, 291`), **5 000 ms** when the caller passes 0
  (`setReadDataTimeout`, `BluetoothConnect_BLE.java:225-231`), 2 000 ms initial default.
* Every frame in the print path expects a response; the fire-and-forget variant (`SendDataPro`) is
  only used for OTA and legacy commands.

### 2.5 Notify reassembly — CONFIRMED (`BluetoothConnect_BLE.java:650-715`)

```
on notification value V:
  if len(V) > 4 and V[0..1] == "##" (0x23 0x23): V = V[4..]      # strip 4-byte transport header
  buf += V
  if len(buf) < 3: wait for more
  if buf[0..1] == "**" (0x2A 0x2A): response complete = buf     # e.g. "*****" = printer powering off
  else:
     expected = buf[1]                     # "old printer" (ISSC) service
     expected = (buf[2] << 8 | buf[1])     # "new printer" (ABF0) service
     expected &= 0xFF                      # SDK bug/feature: length is truncated to 8 bits
     when len(buf) >= expected: response complete = buf[0..expected)
```

Consequences for the client: responses are the same `66 LL LL …` frames as commands; the total
length is in byte 1 (byte 2 is effectively ignored). **ASSUMED:** the meaning of the `##xx xx`
prefix (probably a UART-bridge packet header from the ESP32 firmware) — the SDK just discards it.

---

## 3. Frame format — CONFIRMED

```
offset  size  field
0       1     0x66  ('f') start byte
1       2     total frame length, little-endian, INCLUDING start byte and checksum
3       1     command
4       n     payload
last    1     checksum
```

Checksum (`wewinPrinterOperateHelper.getCheckNum`):

```
sum = 0
for b in frame[0 .. len-2]: sum = (sum - b) & 0xFF      # i.e. checksum = (-Σ bytes) mod 256
frame[len-1] = sum
```

Equivalently the sum of **all** frame bytes is ≡ 0 (mod 256). Examples: `66 06 00 10 00` → `84`;
`66 05 00 50` → `45`.

Length encoding (`wewinPrinterByteHelper.Integer2HexString` + `HexString2Bytes`): 16-bit
little-endian; when the length ≤ 255 the high byte is written as 0. **CONFIRMED**

Legacy (pre-1.3, "old protocol") frames use a **one-byte** length field (`66 05 A0 00 F5`,
`66 05 A1 00 F4`, `66 07 A2 dir 01 nn CK`, `66 05 A5 nn CK`, `66 04 AE CK`, `66 05 B5 00 E0`,
`66 06 BD id_lo id_hi CK`, `66 06 E5 nn mode CK`). The SDK explicitly refuses to send these to
"new protocol" printers (`doOperatePrinterCommand`, every branch returns `null` when
`IsNewProtocolPrinter`). Not for the E1. **CONFIRMED**

---

## 4. Command table (wewin new protocol)

| Frame (hex) | Name | Direction / response | Where |
|---|---|---|---|
| `66 06 00 10 00 84` | **Status / heartbeat / attribute query** (`0x10`, sub 0 "search") | Status frame §6 (≥36 B; ≥43 B when protocol ≥1.3) | `operate10Check`, `checkConnectOperate`, `operateShakeHand(search)` |
| `66 06 00 10 01 83` | Pause print job (`0x10`, sub 1) | Status frame | `operateShakeHand(pause)` |
| `66 06 00 10 02 82` | Resume print job (`0x10`, sub 2). Also sent once **before the first label** of every job. | Status frame | `operateShakeHand(restore)`, `run():375-381` |
| `66 06 00 10 03 81` | Cancel print job (`0x10`, sub 3) | Status frame | `operateCancelCommand` |
| `66 LL LL 1B …` | **Print band** (raster data), see §7 | Status frame; may be `wait` | `operate1BCommand` |
| `66 LL LL 1A …` | RFID write (`[loc][len][data…]` records, loc 0=reserved 1=epc 2=tid 3=user) | Status frame | `operate1ACommand` — **not relevant to E1** (E1 reports no RFID bit) |
| `66 05 00 50 45` | **Firmware / hardware version query** | `66 LL LL 50 <str>\0<str>\0…CK`; from byte 4, NUL-separated UTF-8 strings: `[0]` hardware, `[1]` firmware | `operatePrinterFirmware`, `doOperateCheckPrinterFirmware`, `PrinterManagerService.getFirmware` |
| `66 06 00 B9 00 CK` | "printer charge" query, new-protocol variant | — | only sent to H50/H51 (`IsH50SeriesPrinter`) |
| `66 04 AE CK` (legacy) | DPI query for old-protocol printers | `[4]`: 1=203, 2=300, 3=300-font, 4=203-font | `CheckPrinterAttributeEvent` else-branch, **not for E1** |

Sub-byte for `0x10` is payload byte 4: `0`=search/status, `1`=pause, `2`=restore, `3`=cancel.
**CONFIRMED** (`OperateNewProtocolPrinterRunnable.java:30-48`).

The firmware-update protocol (`wewinPrinterUpdateFirmware.java`, 2048-byte blocks) and the S1
"entry/date" commands (`doOperatePrinterSetBasicInfo`, `doUpdatePrinterEntry`) were not analysed;
they are out of scope for printing.

---

## 5. Connection and idle behaviour

### 5.1 Attribute query at connect — CONFIRMED (`wewinPrinterOperateHelper.java:3226-3430`)

After the BLE "connected" callback + 200 ms the SDK sends `66 06 00 10 00 84` up to **3 times**
(200 ms apart) until it gets a response with `resp[3] == 0x10` and `resp[1] == len(resp)`. From it:

* `resp[6] & 0x07` → horizontal DPI code (0→203, 1→300, 2→600, 3→180, 4→288); bit 6 → RFID printer.
* `resp[15] & 0x0F` → vertical DPI code (0→use default/horizontal, 1→203, 2→300, 3→600, 4→180, 5→288).
* If `len ≥ 43`: `protocolVersion = float("%d.%d" % (resp[36], resp[37]))`. If ≥ 1.3:
  * `resp[38] & 0x03` → print position across head: 0 = left, 2 = right, other = **center**
  * `(resp[38] >> 2) & 1` → `exchangeHL` (swap each pair of raster bytes, §7.3)
  * `resp[39] | resp[40] << 8` → **print head width in BYTES** (dots = ×8)
  * `resp[41] | resp[42] << 8` → **max rows per band** (`maxPrintRows`)
* If the query fails, defaults: DPI 203 (`getPrinterDefaultDpi` → 300 for known new-protocol names,
  203 for unknown names like `e1`), head width 72 bytes (576 dots), 56 rows, center, no swap,
  protocol 1.0 (`wewinPrinterManager.restoreAllPrinterParams`).

**Client must implement this query and use the reported width / band height.** The E1's actual
values are **TODO (hardware)**. Expected (ASSUMED, see §9): 203 dpi, 12 bytes = 96 dots.

### 5.2 Heartbeat — CONFIRMED (`wewinPrinterConnectionHelper.java:283, 481-535, 723-760`)

Every **1000 ms** the SDK sends `66 06 00 10 00 84` and reads the response (paused while a print job
or a command is in flight). It uses the response for:

* battery: `resp[5] & 0x7F` (127 → 100 %), charging: `resp[5] & 0x80`
* `66 06 00 11 00 83` (6 bytes, cmd echo `0x11`) → **printer occupied by another host** → disconnect
  reason `occupied`
* `resp[3..7] == "*****"` → **printer powering off** → disconnect reason `power_off`
* no response → after the timer's timeout the socket is closed ("printer off or out of range")

The client does not have to poll this fast, but polling `0x10` is the only way to get status and
battery; there is no unsolicited status push in this protocol. **CONFIRMED**

---

## 6. Status frame (response to `0x10` and to `0x1B`) — CONFIRMED (`parsePrinterStatus`, `parsingResponseByteArray`, `CheckPrinterAttributeEvent`)

```
byte   meaning
0      0x66
1-2    length (LE); the BLE reassembler only uses byte 1
3      0x10 (command echo). 0x11 here with total length 6 = "occupied"
4      bit7 = WAIT/busy   bit6 = RESEND   bits0-5 = status code (table below)
5      bit7 = charging    bits0-6 = battery %, 127 means 100
6      bits0-2 = horizontal DPI code (0:203 1:300 2:600 3:180 4:288)
       bit3 = has cutter  bit4 = has Bluetooth  bit5 = has Wi-Fi  bit6 = has RFID  bit7 = has M2M
7      bits0-4 = current darkness   bits5-7 = label thickness / shear mode
8-9    "labelHeight" LE (units unknown — ASSUMED tape width in dots or mm)
10-14  printer type, 5 ASCII chars (0x00 shown as space)
15     bits0-3 = vertical DPI code (0:default 1:203 2:300 3:600 4:180 5:288)
16-17  label remaining length LE
18-19  label total length LE
20-33  label type number, 14 ASCII chars
34     ribbon number (0xFF = none)
35     bits0-3 = print speed   bits5-6 = request from printer (1 = pause, 3 = cancel)   bit7 = printing
36     protocol version major
37     protocol version minor
38     bits0-1 = print position (0 left, 2 right, else center)   bit2 = exchangeHL
39-40  head width in bytes LE
41-42  max rows per band LE
last   checksum (ASSUMED at position len-1, as for commands)
```

A response shorter than 36 bytes is treated as "resend" unless it is the 6-byte `0x11` frame
(`resnull`). **CONFIRMED** (`wewinPrinterParsingProtocol.java:45-54`)

### 6.1 Status code (`resp[4] & 0x3F`) → SDK error id → meaning — CONFIRMED (`wewinPrinterParsingProtocol.java:63-131`, `doFindMessageByStatusId`)

| code | SDK id | meaning (translated from the Chinese resource key) |
|---|---|---|
| 0, 23 | 0 | OK |
| 1 | 17 | no label cassette |
| 2 | 7 | data storage failure |
| 3 | 15 | label used up |
| 4 | 19 | label not recognised (use genuine consumable) |
| 5 | 20 | no label cassette |
| 6 | 6 | cover open / lock lever open |
| 7 | 42 | label not recognised |
| 8 | 29 | print head over-temperature |
| 9 | 24 | cutter jammed |
| 10 | 22 | ribbon abnormal |
| 11 | 12 | printer busy (in menu / mode selection) |
| 12 | 27 | wrong power adapter |
| 13 | 37 | paper jam |
| 14 | 38 | printer off or in standby |
| 15 | 39 | label abnormal (gap setting) |
| 16 | — | **exit**: printer cancelled the job |
| 17 | — | **reprint** requested |
| 18 | 44 | unlock and insert ribbon cassette |
| 19 | 9 | ribbon used up |
| 20 | 45 | unrecognised ribbon |
| 21 | 46 | print head fault |
| 22 | 47 | ribbon installed in thermal mode |
| other | 35 | unknown status |

The app's coarse status (`PrinterStatusUtils`): raw code 0 → OK (≤ 20 % battery and not charging →
LowPower), 1/3/4/5/13 → OutPaper, 6 → OpenCover, 8 → OverHeat, 11 → Busy, else Others.

### 6.2 Response classification used by the print loop — CONFIRMED

```
resnull  : no bytes, or the 6-byte 0x11 frame
resend   : len < 36, or bit6 of byte 4 set          -> send the same frame again
wait     : bit7 of byte 4 set                        -> poll 0x10/00 until it clears
error    : status code != 0 (except 16, 17)          -> abort (or auto-pause), report code
exit     : code 16, or byte35 bits5-6 == 3           -> job cancelled by printer
reprint  : code 17
pause    : byte35 bits5-6 == 1                       -> printer asks to pause
success  : otherwise
```

---

## 7. Raster / image encoding — CONFIRMED (`CreateNewProtocolArray.java:1225-1360`, `LZOUtil.java`)

### 7.1 Geometry

* The label bitmap is rendered at printer DPI (app labels are authored at 203 dpi =
  7.992126 px/mm for the E1, `StaticArgs.dpiConvertPX()`), scaled by
  `printerDPI / labelDPI` (1.0 when equal).
* `printDirect` (app always uses **1**, `PrinterManagerService.java:703,760`) rotates the label by
  `printDirect × 90°`. For `printDirect` 1 or 3 the label's **height** (its tape-width extent) is
  what ends up across the print head and the label's width becomes the feed length.
* The head-axis extent is rounded **up to a multiple of 8 dots** before rotation.
* The rotated image is then composited onto a canvas exactly `headWidthBytes × 8` dots wide
  (`i32 = printerWidth*8`), positioned per `printPosition` (center by default: offset
  `(headDots − imgWidth)/2`, cropped symmetrically if the image is wider than the head).
* Feed-direction length is capped at the label's own length (`i31`); the app never pads to a fixed
  label length — the printer feeds/cuts per its own settings (see §8 for the clearance bits).

### 7.2 Bit packing

* **1 bit per pixel, 1 = print (black), MSB first**: the leftmost pixel of a row is bit 7 of the
  first byte.
* Threshold: each RGB channel is compared with `dotConvertValue = 128`; a pixel is black when the
  thresholded ARGB value is neither `0x00000000` nor `0xFFFFFFFF`, i.e. when it is not fully
  transparent-black and not white (any channel < 128 → black). Alpha itself is not otherwise used.
* Bytes per row = `ceil(width / 8)`; the last byte of a row is zero-padded; rows are stored
  consecutively (row-major), width = `min(image width, head dots)`.

### 7.3 `exchangeHL`

When the printer set bit 2 of status byte 38, **each pair of bytes is swapped** (byte `2k` ↔ byte
`2k+1` over the whole band buffer, i.e. 16-bit little-endian word order). Default when unknown:
`true` (`wewinPrinterManager.isExchangeHL = true` after `restoreAllPrinterParams`), but the value is
always overwritten from the status frame when protocol ≥ 1.3. **ASSUMED for E1: read it from the
printer, never hard-code.**

### 7.4 Banding and compression

* The bitmap is cut into horizontal **bands of `maxPrintRows` rows** (status bytes 41-42; default
  56). The last band may be shorter.
* Each band (`bytesPerRow × bandRows` bytes) is compressed **separately** with **LZO1X-1**
  (minilzo `lzo1x_1_compress`, `org/minilzo/common/MiniLZO.java`). The output is the raw LZO1X
  stream — no header, no length prefix, ending with the standard `11 00 00` end-of-stream marker.
  Uncompressed size is implied by `bytesPerRow × bandRows`.
* No other compression (no RLE) and no 4-bpp/grey modes exist in this code path. **CONFIRMED**

### 7.5 Limits

* Band rows, label height and copy counters are 16-bit fields; the remaining-bands counter is
  8 bits (`(count − i − 1) & 0xFF`), so a label may have at most 256 bands = 256 × maxPrintRows
  rows (14 336 rows ≈ 1.79 m at 203 dpi with the default 56). **CONFIRMED (field widths)**
* App-side limits for the E1: minimum label length **10 mm**, "continuous" label total length
  **4000 mm** (`DensityUtils.getFreeLabelMinLength`, `DBUtils.getE1FreeLabel`). **CONFIRMED**

---

## 8. `0x1B` print-band frame — CONFIRMED (`OperateNewProtocolPrinterRunnable.java:192-296`)

```
off  size  value
0    1     0x66
1    2     total length LE = 18 + len(lzo)
3    1     0x1B
4    1     darkness | clearance
             bits0-4: darkness 1..31; 0 (unset) is sent as 31
             bits5-7: 000 "translucent"   (app: die-cut/gap labels, labelType == 2)
                      001 "ddf"           (app: continuous tape, the default)   -> 0x20
                      010 "blackmark"                                          -> 0x40
                      111 "none/transparent"                                    -> 0xE0
             (if ddfGap >= 0 the SDK forces 0x20; the app never sets ddfGap)
5    1     cutType | saveType<<3
             bits0-2: labelCutType: 2 when app printType==1 (single), 3 when printType==2 (multiple/free editor), 7 when unset
             bits3-4: SaveLabelType (S1 feature: 0 none, 1 answer, 2 today) — 0 for E1
6    2     total copies in job LE   (printListCount × printCounts)
8    2     current copy index LE, 1-based
10   1     0x01
11   2     label LENGTH along the feed in dots (rows). SDK: rect[0]=labelWidth × verticalScale when
           printDirect is 1 or 3, rect[1]=labelHeight × verticalScale when printDirect is 0 or 2
           (smali of OperateNewProtocolPrinterRunnable.run, registers v3=0, v11=1, v4=2; jadx had
           collapsed the two branches). HARDWARE-CONFIRMED: the E1 auto-cuts after this many rows.
13   2     rows in this band LE
15   1     bands remaining AFTER this one (0 = last band of this copy)
16   1     0x00
17   n     LZO1X-1 compressed band
last 1     checksum
```

Notes:

* Field 11-12 is the label length along the feed. With `printDirect = 1` (what the app uses)
  the SDK takes the un-rotated label's *width* (`labelRect[0] × verticalScale`); with
  `printDirect = 0` it takes the height. An earlier revision of this document read the jadx output,
  which showed `labelRect[1]` in every branch, and documented the field as the tape-axis extent;
  the bytecode and a hardware test (label cut at exactly the value sent) disproved that.
  **CONFIRMED (smali + hardware)**.
* Darkness values the app uses for the E1: **10 (light) / 15 (default) / 20 (dark)**
  (`DeviceManageActivity.showE1DarknessDialog`). **CONFIRMED**
* Gap vs continuous: the app has no separate "tape type" command; it only flips the clearance bits
  above. For the E1 (`THEME_KEY`, part of `isL1Family()`), gap labels (`labelType == 2`, set when a
  `*_gap` label template is printed) → `0x00`; everything else → `0x20`. **CONFIRMED (app logic)**
  / **ASSUMED (what the E1 firmware does with each value — test both)**.

---

## 9. Model routing inside the SDK — CONFIRMED (`wewinPrinterManager.java`)

* `IsNewProtocolPrinter(name)`: returns true for the explicit list (c18, cs18, tp60/ds60/ml60,
  hs50/ds50/ds51/wb51/wd, p51, q52, d50, cp50, p31, q31, h51, p20, s1, csmax_s1, m1, l1, i70) and
  **also for any name that is not** p70/p70s/p30/p50/p1200/h50. → **`e1…` is a new-protocol printer
  by exclusion.**
* `OperatePrinterRunnable`: if `protocolVersion ≥ 1.3` → `OperateNewProtocolPrinterRunnable`
  (this document). Otherwise by name prefix; `e1` matches nothing → `OperateCommonPrinterRunnable`
  + `CreateCommonDotArray` with a **hard-coded 48-byte (203 dpi) / 72-byte (300 dpi) head**.
  **ASSUMED: the E1 reports protocol ≥ 1.3.** If your printer's status frame is shorter than 43
  bytes or reports < 1.3, the E1 uses the legacy runnable, which was not analysed in depth (it would
  need a second pass over `OperateCommonPrinterRunnable.java` / `CreateCommonDotArray.java`).
* Head-width constants for siblings (bytes/row, from `CreateDotArray`): L1 and M1 **12 bytes = 96
  dots** (18 bytes at 300 dpi), S1 228 bytes, C18/P20 16, D50 48/72, H51/P51 72, CP50 84, I70
  312/156, P70 108/160. The E1 has **no constant** because it never reaches this legacy table when
  the protocol version is ≥ 1.3.

---

## 10. E1-specific parameters

| Parameter | Value | Status |
|---|---|---|
| BLE advertised name | starts with `E1` (or `E1A`); the app lower-cases and `startsWith("e1")` | CONFIRMED (`StaticArgs.KEY`, `PrintThemeChangeEvent`) |
| "Model code sent over the wire" | **none** — the E1 path never sends a model id (`operateSendModelID` is P50-only). The printer instead *reports* a 5-char type string in status bytes 10-14. | CONFIRMED |
| Resolution | 203 dpi (app uses 7.992126 px/mm for the E1; retail listings say 203 dpi). Also read from status byte 6. | CONFIRMED (app) / read from printer |
| Print head width | **TODO (hardware)** — from status bytes 39-40. Expected 12 bytes = 96 dots because the app's printable height for the E1 tops out at 12 mm (`getRealInHeight(16) = 12`) | ASSUMED |
| Max rows per band | **TODO (hardware)** — status bytes 41-42; SDK default 56 | ASSUMED |
| Tape widths | 9, 12, 16 mm (app label sizes, retail listing) | CONFIRMED (app) |
| Printable height per tape | 9 mm → 8 mm, 12 mm → 11 mm, 16 mm → 12 mm (`DensityUtils.getRealInHeight`, E1 branch) | CONFIRMED |
| Label margins (app defaults) | 16 mm tape: top/bottom 2 mm; 12 & 9 mm: 0 (`DBUtils.getE1FreeLabel`) | CONFIRMED |
| Min / max label length | 10 mm / 4000 mm (app) | CONFIRMED |
| Cut mark between labels (`cutFlag`) | drawn **into the bitmap** by the app: an extra `round(7.99 × 2) + 6` px of white plus a dotted line; not a printer command | CONFIRMED (`BitmapUtils.addCutFlagBitmap`) |
| Density presets | 10 / 15 / 20 (default 15) | CONFIRMED |
| Cutter | manual lever; `getPrinterCutterMethod("e1") = none`; app still sends cutType 2 or 3 | CONFIRMED |
| Continuous vs gap | clearance bits in `0x1B` byte 4 (§8) | CONFIRMED (bits) / ASSUMED (firmware behaviour) |
| Firmware naming | `E1_V1.0_V1.0_220921.2.bin` appears as a string constant in 2.2.0 (firmware update file name pattern) | CONFIRMED |

---

## 11. Full print sequence (pseudocode)

```
connect():
  device = requestDevice(filters: namePrefix "E1", optionalServices: [ABF0, 49535343-FE7D…])
  gatt   = device.gatt.connect()
  svc    = try ABF0 -> write ABF1, notify ABF2; else 49535343-FE7D… -> write …8841…, notify …1E4D…
  startNotifications(notify)              # CCCD written by the browser
  sleep 200 ms
  attrs  = query()                        # §5.1, up to 3 tries
  fw     = send(66 05 00 50 45)           # optional: hardware/firmware strings
  every 1000 ms while idle: status = send(66 06 00 10 00 84)     # battery, errors, "occupied", "*****"

query():
  resp = send(66 06 00 10 00 84)
  require resp[3] == 0x10 and resp[1] == len(resp)
  dpi        = table[resp[6] & 7]
  if len(resp) >= 43 and version(resp[36], resp[37]) >= 1.3:
      headBytes = resp[39] | resp[40] << 8
      maxRows   = resp[41] | resp[42] << 8
      position  = resp[38] & 3
      swapHL    = (resp[38] >> 2) & 1
  else: TODO — legacy path, see §9

print(labelBitmap, copies, darkness=15, clearance=0x20, cutType=3):
  img    = rotate90(labelBitmap)                       # printDirect = 1
  img    = centreOnCanvas(img, width = headBytes*8)    # per `position`
  rows   = packBits(img)                               # 1 bpp, MSB first, ceil(w/8) bytes/row
  if swapHL: swapBytePairs(rows)
  bands  = split(rows, maxRows)                        # each: bytesPerRow*bandRows bytes
  lzo    = [lzo1x_1_compress(b) for b in bands]
  labelLen = height(rows)                              # feed length in dots (field 11-12); the printer cuts here

  loop: r = send(66 06 00 10 02 82) until classify(r) != resend     # "restore" before first label
  for copy in 1..copies:
      # handshake
      loop:
        r = send(66 06 00 10 00 84)
        c = classify(r)
        if c == exit: abort
        if c == pause: keep polling (printer paused)
        if c == error: report code, abort (SDK: auto-pause and keep polling)
      while c in {resend, pause, error, wait}
      # data
      for i, band in enumerate(bands):
          frame = 1B(darkness, clearance, cutType, total=copies, index=copy,
                     labelLen, bandRows=len(band)/bytesPerRow, remaining=len(bands)-i-1, lzo[i])
          loop: r = send(frame) while classify(r) == resend
          while classify(r) == wait:  r = send(66 06 00 10 00 84)
          if classify(r) == exit:     abort (printer cancelled)
          if classify(r) == resnull:  abort (no answer within 10 s)
      # copy done when the band with remaining == 0 was acknowledged
  # no end-of-job frame exists

cancel(): loop: r = send(66 06 00 10 03 81) while classify(r) == resend
pause():  66 06 00 10 01 83      resume(): 66 06 00 10 02 82
```

Which notify response gates each step: **every** frame is followed by exactly one status frame
(§6); the SDK never sends the next frame before the previous response (or a 10 s timeout). The only
multi-response wait is the `wait` bit, handled by polling `0x10/00`.

---

## 12. Hardware verification status

Tested on 2026-09-04 with an E1, serial `E124H01005`, hardware `V1.0A`, firmware `V1.0_230106.1`,
12 mm tape, Chrome Web Bluetooth, 20-byte write chunks. **HARDWARE-CONFIRMED:**

1. UART service: `ABF0`; write char `ABF1` has properties Read + WriteWithoutResponse; notify char
   `ABF2` has Read + Write + Notify. Writes without response are accepted.
2. Notifications arrive as complete 44-byte status frames with **no** `##` prefix; byte 1 = 0x2C =
   44 = total length; checksum is the last byte and verifies.
3. Attribute response of this unit (bytes 36-42): protocol `1.30`, position center, exchangeHL
   **false**, head **12 bytes = 96 dots**, **170 rows per band**. Byte 6 = 0x18: 203 dpi, **has
   cutter**, has Bluetooth. Byte 15 = 0x01: vertical 203 dpi. Bytes 8-9 = 0x00AB = 171 (meaning
   still unknown). Byte 34 = 0x01. Byte 7 echoes the darkness last sent (20 → 15 after our print).
4. Firmware query `66 05 00 50 45` answers `66 24 00 50 "V1.0A"\0 "V1.0_230106.1"\0 "E124H01005"\0 17`:
   hardware, firmware, serial.
5. `0x10 resume`, `0x10 search` and a 359-byte `0x1B` band (1776 raw bytes → 341 LZO) were each
   answered within ~60-120 ms with code 0; the label printed legibly, so raster orientation, MSB
   bit order, no byte swap, LZO1X-1 and the checksum are right. Clearance `0x20` works on
   continuous tape.
6. Bytes 11-12 are the label length along the feed: with 88 there and a 148-row label the
   auto-cutter cut at row 88 (mid "s" of "test"). Fixed by sending the feed length.

Still **TODO**:

* Whether the printer adds its own head-to-cutter feed after the last row (check that a
  right-hand margin of 2 mm survives the cut), or whether a trailing white margin is needed.
* Behaviour of clearance `0x00` (die-cut).
* Cut type: **HARDWARE-OBSERVED** that value 2 does *not* make the E1 cut between copies of one
  job; the printer cuts once at the end of a job whatever the bits say. The official app relies on
  this too (it paints dotted cut marks between copies). Per-copy cutting = one job per copy.
* Meaning of status bytes 8-9 (171 on this unit) and 34.
* Largest accepted write chunk (only 20 B tested).

---

## Appendix A — PrintPP / AiYin path (L1A, Q1 devices; NOT the E1) — CONFIRMED (`com/example/sdk/e.java`)

Kept because it is fully traced and identical to the Fichero D11s protocol, in case the E1 firmware
turns out to answer these instead. Transport in this app: classic Bluetooth SPP
(`00001101-…`), 1024-byte writes with 1 ms sleeps.

| Bytes | Meaning |
|---|---|
| `10 FF 20 F0` / `F1` / `F2` | model / firmware / serial (ASCII reply) |
| `10 FF 30 10` / `11` / `12` | BT firmware / BT name / MAC |
| `10 FF 50 F1` (`F0`) | battery (variant) |
| `10 FF 40` | status byte |
| `10 FF FF rr` | handshake with random byte; reply byte 0 must equal `(hi & lo) \| ((hi \| lo) << 4)` where `hi = rr >> 4`, `lo = rr & 15` |
| `10 FF FE 01` / `45` / `40` | enable printer / stop job / back-feed |
| `10 FF 03` | learn label gap |
| `10 FF 10 00 nn` | density; `10 FF 10 02 nn` time mode; `10 FF 12 hh ll` shutdown minutes; `10 FF 14 02 y m d h m s w` set time; `10 FF 60 0/1` unknown toggle |
| `10 FF 15 05 …` | download bitmap to flash (1024-byte chunks, 8-bit additive checksum, expects `CC` ack); `10 FF 15 06` check flash bitmap |
| 1024 × `00` | wake-up |
| `1B 4A nn` | feed nn dots; `1D 0C` form-feed to next label |
| `1D 76 30 m xL xH yL yH` + bits | ESC/POS raster (GS v 0), 1 bpp MSB-first, `xL xH` = bytes/row, `yL yH` = rows |
| `1F 00 wH wL hH hL sz(4, BE) + deflate` | compressed raster for models whose type string contains 303/320/330: zlib `compress()` output with its 2-byte header removed (raw deflate + adler32 trailer, `Code.code` JNI) |
| `1F B2 10` | sent after enable on 303/320/330 models |
| Async status `FF nn` | 1 out of paper, 2 cover open, 3 over-heat, 4 low battery, 5 charging, 6 not charging |

Print sequence used by the app for these models: wake-up → `10 FF FE 01` → raster (`1D 76 30` or
`1F 00`) → `1D 0C` (label mode) or `1B 4A nn` feed → `10 FF FE 45`.

---

## 13. Where each part is implemented (`src/printer/`)

| Section | File |
|---|---|
| §2 BLE services, characteristic selection, chunked writes, reconnect | `webbluetooth.ts` |
| §2.5 notify reassembly (`##` strip, `**`, length byte) | `reassembler.ts` |
| §3 frame format and checksum | `frames.ts` (`buildFrame`), `checksum.ts` |
| §4 / §6 commands, status frame decoding, response classes, error table | `frames.ts` |
| §5 connect-time attribute query, heartbeat, firmware query | `client.ts` |
| §7 raster: threshold, rotate 90° cw, head placement, MSB-first packing, byte-pair swap, banding | `raster.ts` |
| §7.4 LZO1X-1 | `lzo1x.ts` (compressor + decompressor for tests) |
| §8 / §11 `0x1B` frame and the print sequence | `frames.ts` (`buildPrintBandFrame`), `job.ts` (`planPrintJob`), `client.ts` (`print`) |

Unit tests in `src/printer/__tests__/` pin the SDK byte constants (`66 06 00 10 00 84`,
`66 05 00 50 45`, …), the `0x1B` layout, the status-frame bit fields, the reassembly rules, the
raster bit order and the LZO round trip.
