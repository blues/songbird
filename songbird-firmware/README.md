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

## Serial Monitor

```bash
# Open serial monitor (115200 baud)
pio device monitor
```

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

## Debug Build

The debug build (`cygnet_debug` environment) enables:

- Verbose serial logging
- Stack usage monitoring
- Extended error reporting

```bash
pio run -e cygnet_debug -t upload
```

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.
