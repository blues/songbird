# Songbird Firmware

Firmware for the Songbird sales demo device - a portable, battery-powered asset tracker and environmental monitor built on the Blues Cygnet platform.

## Features

- Environmental sensing (temperature, humidity, pressure) via BME280
- GPS/GNSS location tracking via Notecard
- Audio feedback via piezo buzzer with configurable melodies
- Remote configuration via Notehub environment variables
- Cloud-to-device command handling
- Low-power operation with ATTN-based sleep
- FreeRTOS multitasking architecture

## Hardware

| Component | Description |
|-----------|-------------|
| MCU | Blues Cygnet (STM32L433) |
| Notecarrier | Notecarrier-F with ATTN→EN connection |
| Notecard | Cell+WiFi (NBGL) |
| Sensor | BME280 Qwiic breakout |
| Audio | Passive piezo buzzer on PA8 |

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
- Blues Cygnet development board

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
|-------|----------|
| ST-Link not detected | Check USB connection, try different port |
| Upload fails | Verify SWD wiring, check ST-Link firmware |
| No serial output | Ensure debug build is flashed, check VCP port |
| Garbled output | Verify baud rate is 115200 |

## Architecture

The firmware uses FreeRTOS with 6 tasks:

| Task | Priority | Description |
|------|----------|-------------|
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

| Mode | Description |
|------|-------------|
| `demo` | Continuous sync, rapid GPS updates, all features enabled |
| `transit` | Periodic sync (configurable), motion-triggered tracking |
| `storage` | Hourly sync, minimal power consumption |
| `sleep` | Deep sleep with wake triggers |

## User Button (Mute Toggle)

The user button on the Notecarrier can be used to quickly mute or unmute all audio feedback without needing to change cloud configuration.

### How to Use

- **Press the button once** to toggle between muted and unmuted states
- **Rising tone (C→E→G)** confirms audio is now **unmuted**
- **Falling tone (G→E→C)** confirms audio is now **muted**

### Behavior

| State | Audio Behavior |
|-------|----------------|
| Unmuted | All audio plays normally (power-on, alerts, notifications) |
| Muted | All audio is silenced, including alerts and locate mode |

**Note**: The mute state is temporary and resets to the configured `audio_enabled` setting after a device reboot or sleep cycle. For persistent audio control, use the `audio_enabled` environment variable in Notehub.

### Hardware

The button connects to GPIO pin PA9 with an internal pull-up resistor. The button is active-low (pressed = LOW).

## Configuration

Configuration is managed via Notehub environment variables:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `mode` | string | demo | Operating mode |
| `gps_interval_min` | number | 5 | GPS update interval (minutes) |
| `sync_interval_min` | number | 15 | Cloud sync interval (minutes) |
| `temp_alert_high_c` | number | 35 | High temperature alert threshold |
| `temp_alert_low_c` | number | 5 | Low temperature alert threshold |
| `audio_enabled` | boolean | true | Enable audio feedback |
| `audio_volume` | number | 50 | Audio volume (0-100) |
| `motion_sensitivity` | string | medium | Motion sensitivity (low/medium/high) |

## Commands

The device accepts commands via the `command.qi` notefile:

| Command | Description |
|---------|-------------|
| `ping` | Device responds with acknowledgment |
| `locate` | Play locate beep pattern for specified duration |
| `play_melody` | Play named melody (power_on, connected, alert, etc.) |
| `test_audio` | Play test tone at specified frequency |
| `set_volume` | Adjust audio volume |

## Notefiles

| Notefile | Direction | Description |
|----------|-----------|-------------|
| `track.qo` | Outbound | Telemetry data (temp, humidity, pressure, voltage, motion) |
| `alert.qo` | Outbound | Alert notifications (threshold violations) |
| `command_ack.qo` | Outbound | Command acknowledgments |
| `health.qo` | Outbound | Device health/status reports |
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
|-------|----------|
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
