# ioBroker.zeptrion

![Logo](admin/zeptrion.png)

[![NPM version](https://img.shields.io/npm/v/iobroker.zeptrion.svg)](https://www.npmjs.com/package/iobroker.zeptrion)
[![Downloads](https://img.shields.io/npm/dm/iobroker.zeptrion.svg)](https://www.npmjs.com/package/iobroker.zeptrion)
[![Tests](https://github.com/bueste/ioBroker.zeptrion/workflows/Test%20and%20Release/badge.svg)](https://github.com/bueste/ioBroker.zeptrion/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Adapter for Feller **zeptrion / zApp** WLAN actuators (WLAN Nebenstelle 4K = zApp gateway,
WLAN Zwischenmodul 2K = zApp booster) for light and shutter/blind control, based on the
zrap web service API (Feller document 10.ZEPAPI-E.1612 / version 1.0, firmware from 01.08.18).

_(Eine deutsche Version dieser README ist verfügbar unter [README_de.md](README_de.md).)_

## Feature overview

- **Channel control** (`zrap/chctrl`): on/off/stop/toggle, open/close, move_open/move_close,
  dim_up/dim_down including timed variants (`_t` in ms), as well as scenes
  recall_s1-4 / store_s1-4 / delete_s1-4 - both as individual buttons AND as a free-text
  `command` field.
- **Channel state** (`zrap/chscan` as a periodic resync + `zrap/chnotify` as a long-poll
  push for near real-time updates) and **channel description** (`zrap/chdes`,
  read/write: name, group, icon, type, category).
- **Device information** (`zrap/id`): hardware/software/bootloader version, serial number,
  system name, device type.
- **Signal strength** (`zrap/rssi`, polled).
- **Network status** (`zrap/net`, read-only): SSID, IP, MAC, mode, encryption,
  mask, gateway.
- **System commands** (`zrap/sys`): reboot, factory reset, reset to access-point mode.
- **Location** (`zrap/loc`), **NTP configuration** (`zrap/ntp`) and **date/time**
  (`zrap/date`) including one-click synchronization of the device clock with the ioBroker host.
- **mDNS discovery** (chapter 4 of the API documentation): scans the local network for
  zeptrion devices and adds finds to the configuration table in a disabled state
  (discovery combined with manual review/activation).
- **Bulk commands for hail alerts**: `control.closeAllShutters` / `openAllShutters` /
  `stopAllShutters` control all configured channels across all active devices at once
  - thanks to multicast bundling (see below), as a single request per device, not per channel.
- **Multicast command bundling**: channel commands for the same device that arrive within
  50ms of each other are automatically bundled into a single `zrap/chctrl` multicast POST
  (chapter 3.6.5 of the API documentation) instead of several sequential individual requests.
- **Shutter position estimation** (optional, `posEstimate`): since the hardware, per the
  documentation, practically always reports `-1` (unknown) for shutter channels, a motor
  travel time can be configured per device; the adapter estimates the position from this
  based on direction of movement and elapsed time (best effort, no hardware feedback,
  manually calibratable).
- **Smartfront support** (optional, `zapi/smartfront/*`): read temperature/brightness/
  humidity, set LED background color (only for devices with a connected Feller Smartfront
  switch, checkbox in the configuration).
- Robust error handling: distinguishes ECONNREFUSED/timeout/DNS errors, backoff on
  repeated failures, per-device and global connection status. mDNS discovery is
  additionally hardened against exceptions caused by malformed/unrelated network packets.

Not implemented (see "Known limitations"): write access to `zrap/net`
(changing WLAN credentials), `zrap/scheduler`, Smartbutton webhook programming
(`zapi/smartbt/*`).

## Installation

### a) Local/manual (before store publication)

```bash
cd /opt/iobroker/node_modules
mkdir iobroker.zeptrion
## copy the files of this package here
cd iobroker.zeptrion
npm install --production

cd /opt/iobroker
iobroker upload zeptrion
iobroker add zeptrion
```

### b) Via the ioBroker Adapter Store (once published)

Admin UI -> Adapters -> search for "zeptrion" -> Install.

## Configuration

- **HTTP Timeout**: timeout per request to a device (default 4000 ms).
- **Discovery button**: scans the local network via mDNS (service type `_zapp._tcp`,
  fallback `_http._tcp` for firmware < 01.08.xx based on the hostname pattern
  `zapp-YYWWNNNN`). Newly found devices are added to the table in a **disabled** state
  - review the row afterwards, assign an ID/name, verify the channel count
  (3340-4-x = 4 channels, 3340-2-x = 2 channels) and enable it. mDNS only works
  within the same network segment/VLAN.
- **Device table** (can also be filled in entirely manually, without discovery):
  - `Active`, `ID` (a-z 0-9 _ -), `Name`, `IP address/hostname`,
    `Channels` (1-4), `Kind` (Shutter/Light/unknown - controls the ioBroker object roles,
    see below), `Shutter motor travel time` (seconds, 0=disabled - enables
    `posEstimate`, see below, acts as the default for all channels),
    `Travel time/channel` (optional, comma-separated, e.g. `22,28` - overrides the
    default travel time individually per channel; useful for 2K devices where the two
    channels have different motor travel times; empty entries fall back to
    the default travel time), `Smartfront` (checkbox, only enable if a
    Feller Smartfront switch is connected), `Poll (s)` (default 30, for RSSI +
    periodic chscan resync; the actual channel updates run independently
    via the chnotify long-poll).

## Object tree per device (`zeptrion.0.<id>`)

```
<id>.info.connection / lastError / hw / sw / boot / sn / sys / type / oen / rssi / refresh
<id>.network.ssid / ip / mac / mode / enc / mask / gw / bssid        (read-only)
<id>.system.reboot / unlock / factoryDefault / networkDefault      (buttons; factoryDefault requires unlock within 30s)
<id>.location.name                                                  (read/write)
<id>.ntp.url / per                                                   (read/write)
<id>.date.rfc1123 / tz / dst / syncNow                               (read/write + button)

<id>.channels.chN.val                                    channel state 0-100 / -1 (raw hardware value)
<id>.channels.chN.posEstimate                             only for kind=Shutter: software position estimate
                                                           0=closed/100=open, also manually writable (calibration)
<id>.channels.chN.name / group / icon / type / cat        channel description (read/write)
<id>.channels.chN.command                                 free-text command (string)
<id>.channels.chN.stop / on / off / toggle / open / close /
                  move_open / move_close / dim_up / dim_down        (buttons)
<id>.channels.chN.recall_s1..4 / store_s1..4 / delete_s1..4          (buttons)

<id>.smartfront.temp / lux / hum       only if "Smartfront" is enabled (read)
<id>.smartfront.ledState               current LED status as JSON (read)
<id>.smartfront.ledSet                 set LED(s), JSON array (write)
```

Global:

```
info.connection                at least one device reachable
control.closeAllShutters       button: ALL configured channels -> "close"
control.openAllShutters        button: ALL configured channels -> "open"
control.stopAllShutters        button: ALL configured channels -> "stop"
```

## Object roles and "kind"

The zrap API itself does not distinguish between a light and a shutter channel - that
is purely a matter of wiring/the actuator. So that visualizations (VIS, possibly a
future ioBroker.iot/Alexa integration) can still classify channels meaningfully, the
"kind" can be set per device:

| Kind | `<ch>.val` role | `stop`/`open`/`close` role |
|---|---|---|
| Shutter/blind | `level.blind` | `button.stop` / `button.open.blind` / `button.close.blind` |
| Light | `level.dimmer` | generic `button` |
| unknown (default) | `value` | generic `button` |

Important: `level.blind` does **not** fake genuine position feedback - per the Feller
documentation, `chscan`/`chnotify` for a shutter channel almost always returns `-1`
(unknown), since the hardware itself does not report a blind position. The role only
improves recognition by VIS widgets; the numeric value generally remains uninformative.

## Hail alert usage

```javascript
// JavaScript adapter example
on({id: 'weather.0.warnings.hail', val: true}, function () {
    setState('zeptrion.0.control.closeAllShutters', true);
});
```

Failures on individual devices (offline, etc.) do not interrupt the remaining channels -
each failed channel is logged individually and recorded in `<id>.info.lastError`.

## Known limitations / deliberate decisions

- **Smartbutton webhook programming** (`zapi/smartbt/prgm`/`prgn`/`prgs`) is not
  implemented: this would have the switch call a URL on ioBroker directly on a button
  press (true push, no polling at all). That would require an incoming HTTP server in
  the adapter, which does not currently exist - a larger architectural extension, not a
  small addition. Documented as a possible future enhancement.
- **Write access to `zrap/net`** is not implemented - changing an actuator's WLAN
  credentials via script is risky (loss of connection, reboot required). Can be added
  if needed.
- **Scheduler (`zrap/scheduler`)** and the **zeptrionAir Smartfront services**
  (`zapi/smartfront/*`, `zapi/smartbt/*`) are not implemented, as they are not relevant
  to the shutter/hail use case. The existing `zrapGet`/`zrapPost` structure
  in `main.js` can easily be extended.
- Per the documentation, `chctrl` returns HTTP 302 without a body - redirects are
  deliberately not followed (`maxRedirects: 0`) to avoid unnecessary extra requests.
- On repeated failures for a device, the poll interval is extended up to a maximum of
  5x (simple backoff).

## Development / Tests

```bash
npm install
npm run lint
npm test              # package consistency + unit tests
npm run test:integration   # starts a real js-controller (takes longer)
```

## Changelog

### 0.8.3 (2026-07-14)
- CI workflow activated (lint + tests on every push/PR via GitHub Actions), removed redundant duplicate icon file at repo root (only admin/zeptrion.png is used), cleaned up outdated publish instructions in README

### 0.8.2
- Per-channel motor travel time override (new "Travel/ch (s)" column and CSV column): 2K/4K devices where individual channels have different shutter travel times can now be configured correctly - previously only one travel time applied to all channels of a device

### 0.8.1
- Channel commands (open/close/stop/dim/...) are now logged at info level on send (single and multicast), including failures on warn level - previously only system commands were logged

### 0.8.0
- Fixed orphaned states remaining after a device is removed/replaced (objects are now cleaned up on start), official Feller zeptrion logo as icon (used with permission)

### 0.7.0 (2026-07-10)
- Scaling for 20+ devices: parallel setup, poll jitter, duplicate detection
- Strict startup validation for every configured device row
- CSV bulk import (dedicated config tab) with row validation and auto-ID
- FIX: position estimate correctly handled after a stop during an end-position run
- FIX: adapter timer cleanup (this.clearTimeout), leading zeros in chdes codes are preserved

### 0.6.0 (2026-07-10)
- Auto-ID from host, device test button (reachability + zeptrion verification + channel count check)
- Channel object names taken from the device (chdes), new icon, device icons

### 0.5.1 (2026-07-10)
- CRITICAL FIX: the XML parser skipped the payload because of the XML declaration key - all GET values remained null in 0.5.0

### 0.5.0 (2026-07-07)
- setPosition: time-based %-approach for shutters (chunked due to the 32s API limit, reference run when position is unknown)
- tiltOpen/tiltClose: slat tilt pulses (configurable pulse duration)
- calibrate: set the position estimate without moving

### 0.4.0 (2026-07-07) - Security & quality hardening
- **Locked factory reset**: `system.factoryDefault` now only works within
  30s of setting `system.unlock` - a single accidental setState from a
  script/VIS can no longer wipe the device.
- **Crash-safe onStateChange**: the entire handler (including the bulk commands) now
  runs inside centralized error handling - unhandled promise rejections are
  no longer possible.
- **Input validation**: channel description (32/32/24/4/4 bytes UTF-8), location (32),
  NTP URL (32) and NTP interval (0-255) are validated before sending; a clear
  error message instead of an HTTP 400 from the device. Umlauts are correctly counted as 2 bytes.
- **Adapter-managed timers** (`this.setTimeout`) used everywhere - automatic cleanup
  on unload per the ioBroker guidelines.
- **Connection economy**: as long as the chnotify long-poll is running healthily, the
  redundant chscan resync now only runs on every 5th poll (goes easier on the
  weak embedded web servers of the flush-mounted actuators).
- **chnotify can be disabled** (Expert tab) for environments with connection issues.
- **New admin UI**: tabs (Devices/Expert), fully EN+DE, input validators
  (ID pattern, host pattern), tooltips on every column, security notice.
- Migrated ESLint to flat config (v9), lint runs cleanly; smoke tests for
  command validation, byte limits, position math and multicast body.

### 0.3.0 (2026-07-07)
- Channel commands for the same device are automatically bundled within a 50ms window
  into a single multicast POST to `/zrap/chctrl` instead of being sent sequentially
  one by one - `control.closeAllShutters` (hail alert) in particular
  benefits massively from this (one request per device instead of one per channel).
- Optional time-based shutter position estimate (`posEstimate`) based on a configurable
  motor travel time, since the hardware itself does not report a position.
- Optional Smartfront support (`zapi/smartfront/*`): read temperature/brightness/
  humidity, set LED background color.
- Role fix: `level.blind` is now applied to the position estimate instead of the
  raw (usually -1) hardware value.

### 0.2.0 (2026-07-07)
- Channel states are now primarily updated near real-time via `zrap/chnotify`
  (long-poll) instead of only via interval polling; `chscan` polling remains as a
  periodic resync/fallback.
- An additional safety net (busy window, 5s) prevents a concurrent
  chscan resync from overwriting a just-sent movement command with a stale value.
- mDNS discovery handler hardened against exceptions caused by malformed/unrelated
  network packets (try/catch per service event instead of only around the subscription).
- New device field "kind" (Shutter/Light/unknown) controls the default object roles
  (`level.blind`, `button.stop`, `button.open.blind`, `button.close.blind` resp.
  `level.dimmer`) for better VIS/smart-home integration.
- Structured `native` metadata (host, channel number, kind) on device/channel objects.

### 0.1.0 (2026-07-07)
- First version: channel control, channel state/description, device/network info,
  system commands, location/NTP/date, bulk commands for hail alerts, mDNS discovery.

## License

MIT License

Copyright (c) 2026 Stefan Bühler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
