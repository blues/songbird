# Songbird Firmware

Firmware for the Songbird sales demo device - a portable, battery-powered asset tracker and environmental monitor built on the Blues Cygnet platform.

## Features

- Environmental sensing (temperature, humidity, pressure) via BME280
- GPS/GNSS location tracking via Notecard
- Power monitoring via Blues Mojo (battery voltage, current, mAh consumed)
- Audio feedback via SparkFun Qwiic Buzzer with configurable melodies
- Remote configuration via Notehub environment variables
- Cloud-to-device command handling
- Low-power operation with ATTN-based sleep
- FreeRTOS multitasking architecture

## Hardware

| Component | Description |
| --- | --- |
| MCU | Blues Cygnet OR Notecarrier CX (STM32L433) |
| Notecarrier | Notecarrier-F with ATTN→EN connection OR Notecarrier CX |
| Notecard | Cell+WiFi (MBGLW) |
| Sensor | BME280 Qwiic breakout (I2C address 0x77) |
| Audio | [SparkFun Qwiic Buzzer](https://www.sparkfun.com/sparkfun-qwiic-buzzer.html) (I2C address 0x34) |
| Button | [SparkFun Metal Pushbutton 16mm Green](https://www.sparkfun.com/metal-pushbutton-momentary-16mm-green.html) with LED |
| Power Monitor | [Blues Mojo](https://dev.blues.io/quickstart/mojo-quickstart/) (optional) |

## Project Structure

```
songbird-firmware/
├── src/
│   ├── main.cpp              # Application entry point
│   ├── audio/                # Audio/buzzer subsystem
│   │   ├── SongbirdAudio.cpp
│   │   ├── SongbirdAudio.h
│   │   └── SongbirdMelodies.h
│   ├── notecard/             # Notecard communication
│   │   ├── SongbirdNotecard.cpp
│   │   └── SongbirdNotecard.h
│   ├── sensors/              # BME280 sensor handling
│   │   ├── SongbirdSensors.cpp
│   │   └── SongbirdSensors.h
│   ├── rtos/                 # FreeRTOS tasks and sync
│   │   ├── SongbirdSync.cpp
│   │   ├── SongbirdSync.h
│   │   ├── SongbirdTasks.cpp
│   │   └── SongbirdTasks.h
│   ├── core/                 # Configuration and state
│   │   ├── SongbirdConfig.h
│   │   ├── SongbirdState.cpp
│   │   └── SongbirdState.h
│   └── commands/             # Command and env handling
│       ├── SongbirdCommands.cpp
│       ├── SongbirdCommands.h
│       ├── SongbirdEnv.cpp
│       └── SongbirdEnv.h
├── platformio.ini            # PlatformIO configuration
└── README.md
```

## Prerequisites

- [PlatformIO](https://platformio.org/) (CLI or VS Code extension)
- ST-Link programmer/debugger
- Blues Cygnet development board or Notecarrier CX

## Building

```bash
# Build release firmware
pio run

# Build debug firmware
pio run -e cygnet_debug
```

## Flashing

```bash
# Upload via ST-Link
pio run -t upload

# Upload debug build
pio run -e cygnet_debug -t upload
```

## Debugging with ST-Link

The firmware uses the ST-Link's Virtual COM Port (VCP) for debug serial output, allowing you to debug via the same connection used for programming.

### Hardware Setup

1. Connect the ST-Link V3 (or compatible) to the Cygnet's SWD header
2. The ST-Link provides both programming and serial debug via a single USB connection

### Serial Monitor

Debug output is sent to the ST-Link VCP at 115200 baud:

```bash
# Find the ST-Link VCP port
# macOS: /dev/cu.usbmodemXXXX (look for STLink)
# Linux: /dev/ttyACMX
# Windows: COMx

# Open serial monitor via PlatformIO
pio device monitor

# Or manually with screen (macOS/Linux)
screen /dev/cu.usbmodem14203 115200

# Or with minicom
minicom -D /dev/ttyACM0 -b 115200
```

### Debug Build

The debug build (`cygnet_debug` environment) enables verbose logging:

```bash
# Build and upload debug firmware
pio run -e cygnet_debug -t upload

# Then open serial monitor to see debug output
pio device monitor
```

Debug output includes:
- Task startup messages
- Notecard communication status
- Sensor readings and alerts
- Command execution
- Configuration changes
- Stack usage (periodic health checks)

### GDB Debugging

For interactive debugging with breakpoints:

```bash
# Start debug session
pio debug

# Or in VS Code, use the PlatformIO debug launch configuration
```

### Troubleshooting ST-Link Connection

| Issue | Solution |
| --- | --- |
| ST-Link not detected | Check USB connection, try different port |
| Upload fails | Verify SWD wiring, check ST-Link firmware |
| No serial output | Ensure debug build is flashed, check VCP port |
| Garbled output | Verify baud rate is 115200 |

## Architecture

The firmware uses FreeRTOS with 6 tasks:

| Task | Priority | Description |
| --- | --- | --- |
| MainTask | 3 | System initialization, config management, sleep coordination |
| SensorTask | 2 | Periodic BME280 readings, alert detection |
| AudioTask | 4 | Audio event processing, melody playback |
| CommandTask | 2 | Cloud command polling and execution |
| NotecardTask | 2 | Note queue processing, sync management |
| EnvTask | 1 | Environment variable polling |

### Inter-Task Communication

- **Queues**: Audio events, notes (telemetry/alerts), configuration updates
- **Mutexes**: I2C bus access, configuration access
- **Event Groups**: Sleep coordination between tasks

## Operating Modes

| Mode | Location | Description |
| --- | --- | --- |
| `demo` | Triangulation only | Continuous sync, all features enabled |
| `transit` | GPS tracking | Periodic sync, autonomous GPS tracking enabled |
| `storage` | Triangulation only | Hourly sync, minimal power consumption |
| `sleep` | Disabled | Deep sleep with wake triggers |

## Location Tracking

Songbird supports multiple methods for determining device location:

### GPS Tracking (Transit Mode Only)

In **transit mode**, autonomous GPS tracking is enabled via `card.location.track`:

| Setting | Value | Description |
| --- | --- | --- |
| `card.location.mode` | periodic, 60s | GPS sampling every 60 seconds |
| `card.location.track` | start, heartbeat, sync | Autonomous tracking with hourly heartbeat |

When tracking is enabled:
- The Notecard autonomously records location to `_track.qo` when motion is detected
- Track data includes **velocity** (m/s), **bearing** (degrees), and **distance** traveled
- A **heartbeat** update is sent every hour even when stationary
- Track notes are **immediately synced** to the cloud

In all other modes (demo, storage, sleep), GPS is disabled to conserve power.

### Cell Tower & Wi-Fi Triangulation

All modes (except sleep) enable cell tower and Wi-Fi triangulation via `card.triangulate`. This provides location data when GPS is disabled, with the following benefits:

- **Faster location acquisition**: Triangulation returns results in seconds vs minutes for GPS
- **Indoor location**: Works where GPS signals don't penetrate
- **Lower power consumption**: Wi-Fi scanning uses less power than GPS
- **Always-on location**: Provides location even when GPS is off

Triangulation uses the Cell+WiFi Notecard's ability to scan nearby cell towers and Wi-Fi access points. Notehub processes this data to calculate an approximate location (typically 50-200m accuracy vs 5-10m for GPS).

Triangulated location data is sent via `_geolocate.qo` events. The location source (gps, cell, wifi, triangulation) is included with each location data point so the dashboard can indicate the accuracy level.

### GPS Power Management (Transit Mode)

When in transit mode, the firmware includes intelligent GPS power management to conserve battery when GPS signal is unavailable (e.g., device is indoors or in a covered location):

| Setting | Default | Description |
| --- | --- | --- |
| `gps_power_save_enabled` | true | Enable GPS power management |
| `gps_signal_timeout_min` | 15 | Minutes to wait for GPS signal after activation |
| `gps_retry_interval_min` | 30 | Minutes between GPS retry attempts |

**How it works:**

1. When GPS becomes active (`{gps-active}` status), the firmware starts a timer
2. If no GPS signal (`{gps-signal}`) is acquired within the timeout period, GPS is disabled
3. After the retry interval, GPS is re-enabled to try again
4. When GPS successfully acquires a signal, the timer is reset

This prevents the device from continuously draining the battery trying to acquire a GPS fix when indoors or in poor signal conditions.

**Status reporting:**

- The `gps_power_saving` flag is included in `track.qo` events when GPS is disabled for power saving
- A `gps_no_sat` alert is created when the Notecard reports it cannot acquire satellites
- The dashboard shows visual indicators for both states

### Mode-based Location Summary

| Mode | GPS | Triangulation | Location Source |
| --- | --- | --- | --- |
| Demo | Off | Enabled | `_geolocate.qo` (triangulation) |
| Transit | On (60s tracking) | Enabled | `_track.qo` (GPS) + `_geolocate.qo` |
| Storage | Off | Enabled | `_geolocate.qo` (triangulation) |
| Sleep | Off | Off | None |

## Blues Mojo Power Monitor

[Blues Mojo](https://dev.blues.io/quickstart/mojo-quickstart/) is an optional power monitoring accessory that provides detailed battery telemetry including voltage, current draw, and cumulative energy consumption (mAh).

### Hardware Setup

1. Connect Mojo between your battery and the Notecarrier power input
2. **Important**: Mojo must be connected before the Notecard powers on for automatic detection

### Data Collected

| Metric | Description |
| --- | --- |
| `voltage` | Battery voltage (V) |
| `temperature` | Mojo board temperature (°C) |
| `milliamp_hours` | Cumulative energy consumed (mAh) |

### Reading Intervals

Mojo readings are automatically configured based on the operating mode:

| Mode | Interval |
| --- | --- |
| Demo | Every 1 minute |
| Transit | Every 5 minutes |
| Storage | Every 60 minutes |
| Sleep | Disabled |

### USB Power Detection

Mojo power monitoring is automatically **disabled when the device is USB-powered** and **re-enabled when running on battery**. This prevents unnecessary `_log.qo` events when the device is plugged in for charging or development.

The firmware detects USB power via the `usb` field in the Notecard's `card.voltage` response and only reconfigures Mojo when the power source changes (not on every reading).

The USB power status is also reported to the cloud via `_session.qo` events (the `power_usb` field). The dashboard displays:
- **Blue charging icon** next to the device name when USB powered
- **Green battery icon** next to the device name when running on battery

### Viewing Data

Mojo data is automatically logged to Notehub. To enable automatic power logging:

1. In Notehub, navigate to your device's **Environment** tab
2. Set the environment variable `_log` to `power`
3. Sync the device

Power data will appear in the `_power.qo` notefile.

## Battery Voltage Monitoring

Battery voltage data flows through Notehub system events rather than being sent in the telemetry (`track.qo`) notefile. This approach has several benefits:

- **Reduced data transfer**: Battery readings are sampled and logged by the Notecard automatically
- **Accurate LiPo tracking**: The Notecard uses a LiPo discharge curve for accurate battery percentage
- **Low battery alerts**: The Notecard can trigger immediate syncs when battery is low
- **Unified data source**: Battery info comes from `_log.qo` (Mojo) or `_health.qo` (Notecard) events

### How It Works

1. **Firmware configures voltage monitoring** via `card.voltage` with LiPo mode and alerts enabled
2. **Notecard monitors battery** and reports via system Notefiles
3. **Firmware reads voltage locally** for low battery alert threshold checks
4. **Dashboard retrieves battery** from device metadata (populated from `_log.qo` and `_health.qo`)

### Data Sources

| Source | Notefile | Data | When |
| --- | --- | --- | --- |
| Mojo (if present) | `_log.qo` | voltage, temperature, mAh | Per mode interval |
| Notecard | `_health.qo` | voltage, voltage_mode | On sync/health events |
| Notecard | `_session.qo` | usb power status | On session start |

### Low Battery Alerts

The firmware still generates `low_battery` alerts locally when voltage falls below the configured threshold (`DEFAULT_VOLTAGE_ALERT_LOW = 3.4V`). These alerts are sent via `alert.qo` with immediate sync.

## User Button

The device supports two buttons for user interaction:
- **External panel-mount LED button** (SparkFun Metal Pushbutton 16mm Green) - Primary button with lock indicator LED
- **Internal Cygnet button** (PC13) - Backup button on the Notecarrier CX

Either button can trigger the following functions via single-click, double-click, and triple-click:

### Button Actions

| Action | Result | Audio Feedback | LED |
| --- | --- | --- | --- |
| **Single-click** | Toggle transit lock | Descending (E6→C6→G5) = locked, Ascending (G5→C6→E6) = unlocked | ON when locked |
| **Double-click** | Toggle demo lock | Descending (A6→F6→D6) = locked, Ascending (D6→F6→A6) = unlocked | ON when locked |
| **Triple-click** | Toggle mute | Rising (C→E→G) = unmuted, Falling (G→E→C) = muted | Unchanged |

The panel-mount button's integrated LED illuminates when either transit lock or demo lock is engaged, providing visual feedback of the lock state. The LED state persists across power cycles.

### Transit Lock (Single-click)

Transit Lock allows you to physically lock the device into transit mode, preventing remote mode changes during shipping:

| State | Behavior |
| --- | --- |
| **Unlocked** | Single-click saves current mode and switches to transit mode with GPS tracking |
| **Locked** | Single-click restores the saved mode and unlocks |

When transit lock is active:
- Device operates in **transit mode** with full GPS tracking enabled
- **Environment variable mode changes are blocked** - remote configuration cannot change the mode
- Lock state **persists across sleep cycles** - survives reboots
- Dashboard shows an **amber lock icon** next to the mode badge

This feature is useful when shipping devices - it ensures GPS tracking remains active without accidental remote reconfiguration.

### Demo Lock (Double-click)

Demo Lock allows you to physically lock the device into demo mode, preventing remote mode changes during demonstrations:

| State | Behavior |
| --- | --- |
| **Unlocked** | Double-click saves current mode and switches to demo mode |
| **Locked** | Double-click restores the saved mode and unlocks |

When demo lock is active:
- Device operates in **demo mode** with continuous sync enabled
- **Environment variable mode changes are blocked** - remote configuration cannot change the mode
- Lock state **persists across sleep cycles** - survives reboots
- Dashboard shows a **green lock icon** next to the mode badge

This feature is useful during demonstrations - it ensures demo mode remains active without accidental remote reconfiguration.

### Mute Toggle (Triple-click)

- **Press the button three times** to toggle between muted and unmuted states
- **Rising tone (C→E→G)** confirms audio is now **unmuted**
- **Falling tone (G→E→C)** confirms audio is now **muted**

| State | Audio Behavior |
| --- | --- |
| Unmuted | All audio plays normally (power-on, alerts, notifications) |
| Muted | All audio is silenced, including alerts and locate mode |

**Note**: The mute state is temporary and resets to the configured `audio_enabled` setting after a device reboot or sleep cycle.

### Timing

- Single-click is processed after 1 second delay (to distinguish from multi-clicks)
- Double-click is processed after 600ms-1s from first click
- Triple-click must occur within 1 second window
- Button debounce is 50ms

### Hardware

The device uses two button inputs and one LED output:

| Function | GPIO Pin | Arduino Pin | Description |
| --- | --- | --- | --- |
| External Button | PB9 | D6 | Panel-mount button input (active-low, internal pull-up) |
| Internal Button | PC13 | USER_BTN | Cygnet button backup (active-low, internal pull-up) |
| Lock LED | PB13 | D10 | Panel-mount button LED (active-high, via 100Ω resistor) |

#### Panel-Mount Button Wiring

| Wire Color | Function | Connection |
| --- | --- | --- |
| Green | Switch Common (C1) | PB9 (D6) |
| White | Normally Open (NO1) | GND |
| Blue | Normally Closed (NC1) | Not connected |
| Red | LED+ (Anode) | PB13 (D10) via 100Ω resistor |
| Black | LED- (Cathode) | GND |

## Configuration

Configuration is managed via Notehub environment variables:

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | demo | Operating mode |
| `gps_interval_min` | number | 5 | GPS update interval (minutes) |
| `sync_interval_min` | number | 15 | Cloud sync interval (minutes) |
| `temp_alert_high_c` | number | 35 | High temperature alert threshold |
| `temp_alert_low_c` | number | 5 | Low temperature alert threshold |
| `audio_enabled` | boolean | true | Enable audio feedback |
| `audio_volume` | number | 50 | Audio volume (0-100) |
| `motion_sensitivity` | string | medium | Motion sensitivity (low/medium/high) |
| `gps_power_save_enabled` | boolean | true | Enable GPS power management in transit mode |
| `gps_signal_timeout_min` | number | 15 | Minutes to wait for GPS signal before disabling (10-30) |
| `gps_retry_interval_min` | number | 30 | Minutes between GPS retry attempts |

## Commands

The device accepts commands via the `command.qi` notefile in the format `{"cmd":"<command>"}`:

| Command | Description |
| --- | --- |
| `ping` | Device responds with acknowledgment |
| `locate` | Play locate beep pattern for specified duration |
| `play_melody` | Play named melody (power_on, connected, alert, etc.) |
| `test_audio` | Play test tone at specified frequency |
| `set_volume` | Adjust audio volume |

## Notefiles

| Notefile | Direction | Description |
| --- | --- | --- |
| `track.qo` | Outbound | Telemetry data (temp, humidity, pressure, motion) |
| `_track.qo` | Outbound | GPS tracking data (location, velocity, bearing, distance) - Transit mode only |
| `_geolocate.qo` | Outbound | Triangulated location (cell tower/Wi-Fi) |
| `alert.qo` | Outbound | Alert notifications (threshold violations) |
| `command_ack.qo` | Outbound | Command acknowledgments |
| `health.qo` | Outbound | Device health/status reports |
| `_log.qo` | Outbound | Mojo power monitoring (via Notecard) |
| `command.qi` | Inbound | Cloud-to-device commands |

## Over-the-Air (OTA) Firmware Updates

Songbird supports **Notecard Outboard Firmware Update (ODFU)** for over-the-air firmware updates. This allows you to update the firmware remotely via Notehub without any physical access to the device.

### How ODFU Works

1. The Notecard downloads the firmware binary from Notehub
2. The Notecard resets the host MCU into its ROM bootloader
3. The Notecard flashes the new firmware via UART
4. The host MCU reboots with the new firmware

This process is handled entirely by the Notecard - the host firmware does not participate in the update.

### Hardware Requirements

The Notecarrier-F provides the required wiring:
- **NRST** - Notecard controls host reset
- **BOOT0** - Notecard controls bootloader entry
- **UART TX/RX** - Firmware transfer

Ensure DIP switch 1 (ATTN→EN) is **ON** for proper operation.

### Firmware Version Tracking

The firmware automatically reports its version to Notehub on startup via `dfu.status`. This allows you to see the current firmware version in the Notehub console under **Devices → [Device] → Host Firmware**.

Version information includes:
- Semantic version (e.g., `1.0.0`)
- Organization and product name
- Build timestamp

### Preparing Firmware for OTA Update

1. **Build the firmware:**
```bash
   pio run
```

2. **Package the binary using Notecard CLI:**
```bash
   # Install Notecard CLI if needed
   # https://dev.blues.io/tools-and-sdks/notecard-cli/

   # Package the firmware binary
   notecard -binpack stm32 0x8000000:.pio/build/blues_cygnet/firmware.bin
```

   This creates a `firmware.binpack` file with the proper metadata.

3. **Upload to Notehub:**
  - Go to your Notehub project
  - Navigate to **Settings → Host Firmware**
  - Click **Upload firmware** and select the `.binpack` file
  - Add version notes (optional)

### Deploying Firmware Updates

1. **Via Notehub Console:**
  - Navigate to **Devices → [Device] → Host Firmware**
  - Select the firmware version to deploy
  - Click **Apply DFU**

2. **Via Fleet-wide Deployment:**
  - Navigate to **Settings → Host Firmware**
  - Select the firmware version
  - Choose **Deploy to fleet** or select specific devices

### Monitoring Updates

- **Notehub Console**: Check the **Host Firmware** tab for status ("Downloading", "Applying", "Completed")
- **Device Logs**: The device reports its firmware version after each boot

### Troubleshooting

| Issue | Solution |
| --- | --- |
| Update stuck at "Downloading" | Check cellular/WiFi connectivity |
| Update fails repeatedly | Verify binary was built for correct target (STM32L433) |
| Device unresponsive after update | Check BOOT0/NRST wiring, try manual recovery via ST-Link |
| Version not updating in Notehub | Ensure firmware calls `notecardReportFirmwareVersion()` |

### Manual Recovery

If OTA update fails and the device is unresponsive:

1. Connect ST-Link programmer
2. Flash firmware manually:
```bash
   pio run -t upload
```

### References

- [Notecard Outboard Firmware Update Documentation](https://dev.blues.io/notehub/host-firmware-updates/notecard-outboard-firmware-update/)
- [Notecard CLI binpack Command](https://dev.blues.io/tools-and-sdks/notecard-cli/)

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

Copyright (c) 2025 Blues Inc.
