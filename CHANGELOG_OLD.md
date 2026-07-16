# Older changes

Changelog entries for releases before 0.8.0.

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

