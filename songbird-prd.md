# Songbird: Blues Sales Demo Product

## Product Requirements Document

**Version:** 1.0  
**Date:** December 10, 2025  
**Author:** Brandon / Blues Product Team  
**Status:** Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Overview](#2-product-overview)
3. [Hardware Specification](#3-hardware-specification)
4. [Firmware Application](#4-firmware-application)
5. [Cloud Infrastructure](#5-cloud-infrastructure)
6. [Dashboard Application](#6-dashboard-application)
7. [Demo Scenarios](#7-demo-scenarios)
8. [Success Metrics](#8-success-metrics)
9. [Implementation Plan](#9-implementation-plan)
10. [Appendices](#10-appendices)

---

## 1. Executive Summary

### 1.1 Purpose

Songbird is a portable, battery-powered asset tracker and environmental monitor designed as a sales demonstration tool for the Blues sales and Field Engineering teams. It showcases the full capabilities of the Blues Notecard and Notehub ecosystem in a tangible, memorable package.

### 1.2 Product Name Rationale

"Songbird" was chosen for several reasons:

- **Brand Alignment:** Continues the Blues avian naming theme (Swan, Cygnet, Songbird)
- **Functional Relevance:** The device literally "sings" — it includes audio feedback via a piezo buzzer
- **Memorability:** Evokes imagery of a small device that communicates its status back to the cloud
- **Demo Impact:** The audio feedback creates emotional resonance during customer demonstrations

### 1.3 Key Value Propositions Demonstrated

| Capability | How Songbird Demonstrates It |
|------------|------------------------------|
| **Instant Connectivity** | Power on → connected to cloud in under 3 minutes |
| **Remote Configuration** | Change device behavior via environment variables, no firmware update |
| **Command & Control** | Send commands from cloud, device responds with audio feedback instantly |
| **Low Power Operation** | Weeks of battery life with intelligent sleep management |
| **Sensor Integration** | BME280 environmental sensor via Qwiic/I2C |
| **GPS/GNSS Tracking** | Real-time and historical location visualization |
| **Fleet Management** | Dashboard showing all demo units across teams |
| **Data Optimization** | Templated Notefiles for bandwidth efficiency |
| **Cloud Integration** | Full data pipeline from device to dashboard |

---

## 2. Product Overview

### 2.1 Target Users

| User Group | Use Case |
|------------|----------|
| **Blues Sales Team** | Customer demos, trade shows, proof-of-concept discussions |
| **Blues Field Engineering** | Technical deep-dives, integration guidance, troubleshooting demos |
| **Channel Partners** | Partner-led demonstrations (future phase) |

### 2.2 Core Features

#### Tracking & Location
- GPS/GNSS location acquisition with configurable intervals
- Location history trail visualization
- Motion-triggered wake and reporting

#### Environmental Monitoring
- Temperature measurement (BME280)
- Relative humidity measurement (BME280)
- Barometric pressure measurement (BME280)
- Configurable alert thresholds for all environmental parameters

#### Audio Feedback
- Piezo buzzer for audible status indication
- Signature "Songbird melody" on successful cloud connection
- Distinct tones for alerts, confirmations, and errors
- Remotely configurable audio settings

#### Command & Control
- Cloud-to-device messaging via inbound Notefiles
- Remote "ping" to play notification chime on device
- "Locate" mode with repeating audio pattern (like Find My iPhone)
- Custom melody playback triggered from dashboard
- Command acknowledgment sent back to cloud
- Immediate wake on inbound command (ATTN-based)

#### Power Management
- ATTN-based host MCU power control via Notecarrier-F
- Configurable operating modes (Demo, Transit, Storage, Sleep)
- Battery voltage monitoring and low-battery alerts
- Target: 2-4 weeks battery life in Transit mode

#### Remote Configuration
- All operational parameters configurable via Notehub environment variables
- No firmware update required for configuration changes
- Fleet-wide or per-device configuration options

### 2.3 System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SONGBIRD DEVICE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Cygnet    │  │   BME280    │  │   Piezo     │  │   LiPo      │        │
│  │   (Host)    │  │   Sensor    │  │   Buzzer    │  │   Battery   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│         │    I2C/Qwiic   │      GPIO/PWM  │                │               │
│         └────────┬───────┴────────┬───────┘                │               │
│                  │                                         │               │
│         ┌────────┴────────┐                                │               │
│         │  Notecarrier-F  ├────────────────────────────────┘               │
│         │  (ATTN Control) │                                                │
│         └────────┬────────┘                                                │
│                  │  I2C                                                    │
│         ┌────────┴────────┐                                                │
│         │    Notecard     │                                                │
│         │  (NBGL Cat 1)   │                                                │
│         │  + GPS/GNSS     │                                                │
│         │  + Accelerometer│                                                │
│         └────────┬────────┘                                                │
└──────────────────┼─────────────────────────────────────────────────────────┘
                   │ LTE Cat 1 bis
                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               NOTEHUB.IO                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Product   │  │   Fleets    │  │ Environment │  │   Routes    │         │
│  │  Management │  │  (Teams)    │  │  Variables  │  │  (to AWS)   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └──────┬──────┘         │
└───────────────────────────────────────────────────────────┼─────────────────┘
                                                            │ HTTPS/MQTT
                                                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              AWS CLOUD                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  IoT Core   │─▶│   Lambda    │─▶│ TimeStream  │◀─│ API Gateway │         │
│  │  (Ingest)   │  │ (Process)   │  │  (Storage)  │  │   (REST)    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └──────┬──────┘         │
│                                                            │                │
│  ┌─────────────┐  ┌─────────────┐                          │                │
│  │     S3      │  │   Cognito   │                          │                │
│  │ (Dashboard) │  │   (Auth)    │                          │                │
│  └──────┬──────┘  └─────────────┘                          │                │
└─────────┼──────────────────────────────────────────────────┼────────────────┘
          │                                                  │
          ▼                                                  │
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SONGBIRD DASHBOARD                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Fleet Map  │  Device Detail  │  Charts  │  Config  │  Alerts       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Hardware Specification

### 3.1 Bill of Materials

| Component | Part Number / Description | Quantity | Unit Cost | Notes |
|-----------|---------------------------|----------|-----------|-------|
| **Notecard** | Notecard Cell+WiFi (NBGL) | 1 | ~$49 | Midband LTE Cat 1 bis, GPS/GNSS |
| **Host MCU** | Blues Cygnet | 1 | ~$20 | STM32L433-based, Feather form factor |
| **Carrier Board** | Notecarrier-F v1.3+ | 1 | ~$25 | ATTN→EN connection for power control |
| **Environmental Sensor** | BME280 Qwiic Breakout | 1 | ~$15 | SparkFun or Adafruit, I2C address 0x77 |
| **Audio** | Passive Piezo Buzzer | 1 | ~$2 | 3-5V, ~4kHz resonant frequency |
| **Battery** | 3.7V LiPo, 2000mAh | 1 | ~$12 | JST-PH connector, Feather-compatible |
| **Cellular Antenna** | Molex 213353 or equivalent | 1 | ~$5 | U.FL connector |
| **GPS Antenna** | Molex 206640 or equivalent | 1 | ~$8 | U.FL connector, active or passive |
| **Enclosure** | Custom 3D-printed | 1 | ~$5 | See enclosure requirements |
| **Qwiic Cable** | 50mm Qwiic cable | 1 | ~$1 | For BME280 connection |

**Estimated BOM Cost per Unit:** ~$142

### 3.2 Hardware Assembly

#### 3.2.1 Notecarrier-F Configuration

The Notecarrier-F must be configured for ATTN-based power control:

1. **DIP Switch Settings:**
   - DIP 1 (ATTN→EN): ON (connects Notecard ATTN to Feather EN pin)
   - DIP 2 (AUX→D5): OFF (not used)
   - DIP 3 (AUX→D6): OFF (not used)
   - DIP 4 (GPS→D10): OFF (not used, GPS handled by Notecard)

2. **Antenna Connections:**
   - Main cellular antenna to MAIN U.FL connector
   - GPS antenna to GPS U.FL connector

#### 3.2.2 Sensor Wiring

| Connection | From | To |
|------------|------|-----|
| BME280 | Qwiic connector on sensor | Qwiic connector on Notecarrier-F |
| Piezo Buzzer (+) | Buzzer positive lead | Cygnet GPIO PA8 (D9) |
| Piezo Buzzer (-) | Buzzer negative lead | Cygnet GND |

#### 3.2.3 GPIO Pin Assignments

| Pin | Function | Notes |
|-----|----------|-------|
| PA8 (D9) | Buzzer PWM output | Timer-capable for tone generation |
| PA9 (D10) | User button input | Optional, internal pull-up |
| PB5 (D13) | Status LED | Built-in on Cygnet |
| I2C SDA/SCL | Notecard + BME280 | Shared I2C bus via Qwiic |

### 3.3 Enclosure Requirements

#### Physical Specifications
- **Dimensions:** Approximately 80mm × 50mm × 30mm (L × W × H)
- **Material:** PLA or PETG (3D printed)
- **Color:** Blues blue (#0066CC) or white with Blues logo

#### Design Features
- **Sensor Ventilation:** Small holes or mesh area near BME280 for accurate environmental readings
- **Sound Ports:** Small holes near buzzer location for audio output
- **LED Visibility:** Light pipe or clear window for status LED
- **USB Access:** Opening for USB-C port (charging/debugging)
- **Battery Access:** Removable panel or slide-out battery tray
- **Mounting:** Optional magnetic mount points or belt clip attachment
- **Branding:** Embossed or printed Blues logo and "Songbird" name

---

## 4. Firmware Application

### 4.1 Development Environment

#### 4.1.1 PlatformIO Configuration

```ini
; platformio.ini
[platformio]
src_dir = src

[env:blues_cygnet]
platform = ststm32
board = blues_cygnet
framework = arduino

; Library dependencies
lib_deps =
    blues/Blues Wireless Notecard@^1.6.0
    adafruit/Adafruit BME280 Library@^2.2.2
    adafruit/Adafruit Unified Sensor@^1.1.9
    stm32duino/STM32duino FreeRTOS@^10.3.2

; Upload and debug configuration
upload_protocol = stlink
debug_tool = stlink
monitor_speed = 115200

; Build flags
build_flags =
    -D PRODUCT_UID=\"com.blues.songbird\"
    -D FIRMWARE_VERSION=\"1.0.0\"
    -D HAL_TIM_MODULE_ENABLED
    -D HAL_PWR_MODULE_ENABLED
    ; Include paths for modular structure
    -I src/audio
    -I src/notecard
    -I src/sensors
    -I src/rtos
    -I src/core
    -I src/commands

[env:cygnet_debug]
extends = env:blues_cygnet
build_type = debug
build_flags =
    ${env:blues_cygnet.build_flags}
    -D DEBUG_MODE=1
```

#### 4.1.2 Library Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| Blues Wireless Notecard | ^1.6.0 | Notecard communication |
| Adafruit BME280 Library | ^2.2.2 | Environmental sensor |
| Adafruit Unified Sensor | ^1.1.9 | Sensor abstraction (BME280 dependency) |
| STM32duino FreeRTOS | ^10.3.2 | Real-time operating system for multitasking |

### 4.2 Firmware Architecture

The firmware uses FreeRTOS for multitasking, with a modular directory structure organized by subsystem.

```
songbird-firmware/
├── src/
│   ├── main.cpp                 # Entry point, FreeRTOS scheduler start
│   ├── audio/                   # Audio subsystem
│   │   ├── SongbirdAudio.h      # Buzzer/audio interface
│   │   ├── SongbirdAudio.cpp    # PWM tone generation
│   │   └── SongbirdMelodies.h   # Melody definitions
│   ├── notecard/                # Notecard communication
│   │   ├── SongbirdNotecard.h   # Notecard abstraction
│   │   └── SongbirdNotecard.cpp # note-c wrapper
│   ├── sensors/                 # Environmental sensors
│   │   ├── SongbirdSensors.h    # BME280 interface
│   │   └── SongbirdSensors.cpp  # Sensor reads and alerts
│   ├── rtos/                    # FreeRTOS integration
│   │   ├── SongbirdTasks.h      # Task declarations
│   │   ├── SongbirdTasks.cpp    # Task implementations
│   │   ├── SongbirdSync.h       # Sync primitives (mutexes, queues)
│   │   └── SongbirdSync.cpp     # Sync implementations
│   ├── core/                    # Shared configuration and state
│   │   ├── SongbirdConfig.h     # Config structs and defaults
│   │   ├── SongbirdState.h      # Global state interface
│   │   └── SongbirdState.cpp    # State management
│   └── commands/                # Command handling
│       ├── SongbirdCommands.h   # Command interface
│       ├── SongbirdCommands.cpp # Command execution
│       ├── SongbirdEnv.h        # Environment variable parsing
│       └── SongbirdEnv.cpp      # Env var implementation
└── platformio.ini               # PlatformIO project config
```

### 4.3 FreeRTOS Task Architecture

The firmware runs 6 FreeRTOS tasks with queue-based inter-task communication:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FreeRTOS TASK ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │   EnvTask    │    │  SensorTask  │    │ CommandTask  │                  │
│  │ (Priority 1) │    │ (Priority 2) │    │ (Priority 3) │                  │
│  │              │    │              │    │              │                  │
│  │ • Poll env   │    │ • Read BME280│    │ • Poll       │                  │
│  │   variables  │    │ • Check      │    │   command.qi │                  │
│  │ • Parse      │    │   thresholds │    │ • Execute    │                  │
│  │   config     │    │ • Queue notes│    │   commands   │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │                   │                   │                          │
│         │ configQueue       │ audioQueue        │ audioQueue               │
│         ▼                   │ noteQueue         │ noteQueue                │
│  ┌──────────────┐           │                   │                          │
│  │   MainTask   │◄──────────┴───────────────────┘                          │
│  │ (Priority 2) │                                                          │
│  │              │                                                          │
│  │ • Orchestrate│    ┌──────────────┐    ┌──────────────┐                  │
│  │   startup    │    │  AudioTask   │    │ NotecardTask │                  │
│  │ • Distribute │    │ (Priority 3) │    │ (Priority 4) │                  │
│  │   config     │    │              │    │              │                  │
│  │ • Coordinate │    │ • Play tones │    │ • Send notes │                  │
│  │   sleep      │    │ • Melodies   │    │ • GPS mgmt   │                  │
│  └──────────────┘    │ • Locate mode│    │ • Sync ops   │                  │
│                      └──────────────┘    └──────────────┘                  │
│                             ▲                   ▲                          │
│                             │ audioQueue        │ noteQueue                │
│                             └───────────────────┴──────────────────────────│
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  SYNCHRONIZATION PRIMITIVES:                                               │
│  • g_i2cMutex     - Protects shared I2C bus (Notecard + BME280)           │
│  • g_configMutex  - Protects shared configuration                          │
│  • g_audioQueue   - Audio events → AudioTask                               │
│  • g_noteQueue    - Outbound notes → NotecardTask                          │
│  • g_configQueue  - Config updates → MainTask                              │
│  • g_sleepEvent   - Coordinates deep sleep across all tasks                │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Task Descriptions

| Task | Priority | Stack | Responsibilities |
|------|----------|-------|------------------|
| **MainTask** | 2 (Normal) | 512 words | System orchestration, config distribution, sleep coordination |
| **SensorTask** | 2 (Normal) | 512 words | BME280 reads, alert threshold checks, queue track/alert notes |
| **AudioTask** | 3 (Above Normal) | 256 words | Process audio queue, play melodies/tones, locate mode |
| **CommandTask** | 3 (Above Normal) | 512 words | Poll command.qi, execute commands, queue acknowledgments |
| **NotecardTask** | 4 (High) | 1024 words | Send notes to Notecard, GPS management, sync operations |
| **EnvTask** | 1 (Below Normal) | 512 words | Poll environment variables, parse config, send updates |

#### Inter-Task Communication

| Queue | Sender(s) | Receiver | Item Type |
|-------|-----------|----------|-----------|
| `g_audioQueue` | SensorTask, CommandTask | AudioTask | `AudioQueueItem` |
| `g_noteQueue` | SensorTask, CommandTask | NotecardTask | `NoteQueueItem` |
| `g_configQueue` | EnvTask | MainTask | `SongbirdConfig` |

#### Resource Protection

| Mutex | Protected Resource | Used By |
|-------|-------------------|---------|
| `g_i2cMutex` | Shared I2C bus | NotecardTask, SensorTask |
| `g_configMutex` | Shared configuration | All tasks (read), MainTask (write) |

### 4.4 Operating Modes

The device supports four operating modes, configurable via the `mode` environment variable:

| Mode | GPS Interval | Sync Interval | Motion Sensitivity | Wake Behavior | Use Case |
|------|--------------|---------------|-------------------|---------------|----------|
| **demo** | 1 minute | Immediate | High | Always responsive | Live customer demonstrations |
| **transit** | 5 minutes | 15 minutes | Medium | Motion + timer wake | Asset in active transit |
| **storage** | 60 minutes | 60 minutes | Low | Motion + timer wake | Asset at rest, periodic check-in |
| **sleep** | Disabled | On motion only | Wake-on-motion | Motion wake only | Long-term storage, maximum battery |

### 4.5 Environment Variables

All operational parameters are configurable via Notehub environment variables. Changes take effect on next device sync.

#### 4.5.1 Operating Mode

| Variable | Type | Default | Valid Values | Description |
|----------|------|---------|--------------|-------------|
| `mode` | string | `demo` | demo, transit, storage, sleep | Operating mode preset |

#### 4.5.2 Timing Configuration

| Variable | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `gps_interval_min` | int | 5 | 1-1440 | GPS acquisition interval (minutes) |
| `sync_interval_min` | int | 15 | 1-1440 | Notehub sync interval (minutes) |
| `heartbeat_hours` | int | 24 | 1-168 | Maximum time between syncs (hours) |

#### 4.5.3 Alert Thresholds

| Variable | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `temp_alert_high_c` | float | 35.0 | -40 to 85 | High temperature alert threshold (°C) |
| `temp_alert_low_c` | float | 0.0 | -40 to 85 | Low temperature alert threshold (°C) |
| `humidity_alert_high` | float | 80.0 | 0-100 | High humidity alert threshold (%) |
| `humidity_alert_low` | float | 20.0 | 0-100 | Low humidity alert threshold (%) |
| `pressure_alert_delta` | float | 10.0 | 1-100 | Pressure change alert threshold (hPa) |
| `voltage_alert_low` | float | 3.4 | 3.0-4.2 | Low battery voltage threshold (V) |

#### 4.5.4 Motion Configuration

| Variable | Type | Default | Valid Values | Description |
|----------|------|---------|--------------|-------------|
| `motion_sensitivity` | string | `medium` | low, medium, high | Accelerometer sensitivity |
| `motion_wake_enabled` | bool | true | true, false | Enable motion-triggered wake |

#### 4.5.5 Audio Configuration

| Variable | Type | Default | Valid Values | Description |
|----------|------|---------|--------------|-------------|
| `audio_enabled` | bool | true | true, false | Master audio enable/disable |
| `audio_volume` | int | 80 | 0-100 | Volume level (PWM duty cycle) |
| `audio_alerts_only` | bool | false | true, false | Only play alert sounds |

#### 4.5.6 Command & Control Configuration

| Variable | Type | Default | Valid Values | Description |
|----------|------|---------|--------------|-------------|
| `cmd_wake_enabled` | bool | true | true, false | Wake immediately on inbound commands |
| `cmd_ack_enabled` | bool | true | true, false | Send acknowledgment after command execution |
| `locate_duration_sec` | int | 30 | 5-300 | Duration of locate mode audio pattern |

#### 4.5.7 Display/Debug

| Variable | Type | Default | Valid Values | Description |
|----------|------|---------|--------------|-------------|
| `led_enabled` | bool | true | true, false | Enable status LED |
| `debug_mode` | bool | false | true, false | Enable verbose serial output |

### 4.6 Notefiles and Templates

#### 4.6.1 `track.qo` — Primary Tracking Data

Templated, compact format for bandwidth optimization.

**Template Definition:**
```c
J *req = NoteNewRequest("note.template");
JAddStringToObject(req, "file", "track.qo");
JAddNumberToObject(req, "port", 10);
JAddStringToObject(req, "format", "compact");

J *body = JCreateObject();
JAddNumberToObject(body, "temp", TFLOAT32);        // Temperature (°C)
JAddNumberToObject(body, "humidity", TFLOAT32);    // Relative humidity (%)
JAddNumberToObject(body, "pressure", TFLOAT32);    // Barometric pressure (hPa)
JAddNumberToObject(body, "voltage", TFLOAT32);     // Battery voltage (V)
JAddBoolToObject(body, "motion", TBOOL);           // Motion detected
JAddStringToObject(body, "mode", TSTRING(12));     // Current operating mode
JAddNumberToObject(body, "_lat", TFLOAT32);        // Latitude
JAddNumberToObject(body, "_lon", TFLOAT32);        // Longitude
JAddNumberToObject(body, "_time", TINT32);         // Timestamp
JAddItemToObject(req, "body", body);

NoteRequest(req);
```

**Resulting Template Size:** ~40 bytes per note (before compression)

**Example Note:**
```json
{
  "body": {
    "temp": 23.45,
    "humidity": 48.2,
    "pressure": 1013.25,
    "voltage": 3.92,
    "motion": true,
    "mode": "transit"
  },
  "best_lat": 30.5083,
  "best_lon": -97.6789,
  "best_location_when": 1702234567
}
```

#### 4.6.2 `alert.qo` — Alert Events

Templated format for alert notifications.

**Template Definition:**
```c
J *req = NoteNewRequest("note.template");
JAddStringToObject(req, "file", "alert.qo");
JAddNumberToObject(req, "port", 11);

J *body = JCreateObject();
JAddStringToObject(body, "type", TSTRING(16));      // Alert type
JAddNumberToObject(body, "value", TFLOAT32);        // Measured value
JAddNumberToObject(body, "threshold", TFLOAT32);    // Threshold that was exceeded
JAddStringToObject(body, "message", TSTRING(64));   // Human-readable message
JAddItemToObject(req, "body", body);

NoteRequest(req);
```

**Alert Types:**
- `temp_high` — Temperature exceeded high threshold
- `temp_low` — Temperature below low threshold
- `humidity_high` — Humidity exceeded high threshold
- `humidity_low` — Humidity below low threshold
- `pressure_change` — Significant pressure change detected
- `low_battery` — Battery voltage below threshold
- `motion` — Motion detected (when in sleep mode)

#### 4.6.3 `command.qi` — Inbound Commands

Inbound queue file for cloud-to-device commands. Notes are sent from the dashboard/cloud and retrieved by the device.

**Note Structure:**
```json
{
  "body": {
    "cmd": "ping",
    "params": {}
  }
}
```

**Supported Commands:**

| Command | Parameters | Description |
|---------|------------|-------------|
| `ping` | none | Play single notification chime |
| `locate` | `duration_sec` (optional) | Play repeating "find me" pattern for specified duration |
| `play_melody` | `melody` (string) | Play specific melody: "connected", "alert", "power_on", "low_battery" |
| `test_audio` | `frequency`, `duration_ms` | Play test tone at specified frequency |
| `set_volume` | `volume` (0-100) | Temporarily set audio volume |

**Example Commands:**

```json
// Ping - play notification chime
{"body": {"cmd": "ping"}}

// Locate - play find-me pattern for 60 seconds
{"body": {"cmd": "locate", "params": {"duration_sec": 60}}}

// Play specific melody
{"body": {"cmd": "play_melody", "params": {"melody": "connected"}}}

// Test tone at 1kHz for 500ms
{"body": {"cmd": "test_audio", "params": {"frequency": 1000, "duration_ms": 500}}}
```

#### 4.6.4 `command_ack.qo` — Command Acknowledgment

Outbound queue file for command acknowledgments. Sent after successful command execution.

**Note Structure:**
```json
{
  "body": {
    "cmd": "ping",
    "status": "ok",
    "executed_at": 1702234567
  }
}
```

**Status Values:**
- `ok` — Command executed successfully
- `error` — Command failed (see `message` field)
- `ignored` — Command ignored (audio disabled, etc.)

#### 4.6.5 `health.qo` — Device Health (Optional Custom)

In addition to the built-in `_health.qo`, a custom health note for firmware-specific data.

```json
{
  "body": {
    "firmware": "1.0.0",
    "uptime_sec": 86400,
    "boot_count": 42,
    "last_gps_fix_sec": 120,
    "sensor_errors": 0
  }
}
```

### 4.6 Audio System

#### 4.6.1 Hardware Interface

The piezo buzzer is driven via PWM on a timer-capable GPIO pin:

```c
// Pin definitions
#define BUZZER_PIN PA8  // Timer 1, Channel 1

// PWM configuration
void initBuzzer() {
    pinMode(BUZZER_PIN, OUTPUT);
    analogWriteFrequency(4000);  // Default 4kHz
}

// Play a tone
void playTone(uint16_t frequency, uint16_t duration_ms, uint8_t volume) {
    analogWriteFrequency(frequency);
    analogWrite(BUZZER_PIN, map(volume, 0, 100, 0, 127));
    delay(duration_ms);
    analogWrite(BUZZER_PIN, 0);
}
```

#### 4.6.2 Audio Events

| Event | Sound Pattern | Duration | Notes |
|-------|---------------|----------|-------|
| **Power On** | Rising arpeggio C5→E5→G5→C6 | 500ms | Signals device startup |
| **Notehub Connected** | "Songbird Melody" E5→G5→B5→C6 | 800ms | Signature sound, indicates successful cloud connection |
| **GPS Lock** | Two short beeps (G5, G5) | 200ms | Confirms location acquired |
| **Note Sent** | Single chirp (C6) | 100ms | Confirms data transmission |
| **Motion Detected** | Quick double-beep (E5, E5) | 150ms | Wake-on-motion feedback |
| **Temperature Alert** | Ascending urgent (C5→E5→G5) | 400ms | High or low temp threshold exceeded |
| **Humidity Alert** | Descending tone (G5→E5→C5) | 400ms | High or low humidity threshold exceeded |
| **Low Battery** | Slow sad tones (C5→A4→F4) | 600ms | Battery needs charging |
| **Button Press** | Click (C6) | 50ms | User input confirmation |
| **Entering Sleep** | Descending fade (C6→G5→C5) | 300ms | Device entering low-power mode |
| **Error** | Buzz/raspberry (200Hz) | 300ms | Operation failed |
| **Ping/Notification** | Bright chime (G5→C6→E6) | 400ms | Cloud-triggered notification |
| **Locate Pattern** | Repeating beacon (C6, pause, C6, pause) | Until stopped | "Find my device" pattern |
| **Command Received** | Acknowledgment beep (E6) | 100ms | Command received from cloud |

#### 4.6.3 Melody Definitions

```c
// Note frequencies (Hz)
#define NOTE_C4  262
#define NOTE_D4  294
#define NOTE_E4  330
#define NOTE_F4  349
#define NOTE_G4  392
#define NOTE_A4  440
#define NOTE_B4  494
#define NOTE_C5  523
#define NOTE_D5  587
#define NOTE_E5  659
#define NOTE_F5  698
#define NOTE_G5  784
#define NOTE_A5  880
#define NOTE_B5  988
#define NOTE_C6  1047

// Songbird Signature Melody (played on Notehub connection)
const uint16_t MELODY_CONNECTED[] = {NOTE_E5, NOTE_G5, NOTE_B5, NOTE_C6};
const uint16_t MELODY_CONNECTED_DURATIONS[] = {100, 100, 100, 200};
const uint8_t MELODY_CONNECTED_LENGTH = 4;

// Power On Arpeggio
const uint16_t MELODY_POWER_ON[] = {NOTE_C5, NOTE_E5, NOTE_G5, NOTE_C6};
const uint16_t MELODY_POWER_ON_DURATIONS[] = {100, 100, 100, 200};
const uint8_t MELODY_POWER_ON_LENGTH = 4;

// Low Battery Warning
const uint16_t MELODY_LOW_BATTERY[] = {NOTE_C5, NOTE_A4, NOTE_F4};
const uint16_t MELODY_LOW_BATTERY_DURATIONS[] = {200, 200, 200};
const uint8_t MELODY_LOW_BATTERY_LENGTH = 3;

// Ping/Notification Chime (cloud-triggered)
const uint16_t MELODY_PING[] = {NOTE_G5, NOTE_C6, NOTE_E6};
const uint16_t MELODY_PING_DURATIONS[] = {100, 100, 200};
const uint8_t MELODY_PING_LENGTH = 3;

// Locate Pattern (single iteration, repeated by caller)
const uint16_t MELODY_LOCATE[] = {NOTE_C6};
const uint16_t MELODY_LOCATE_DURATIONS[] = {150};
const uint8_t MELODY_LOCATE_LENGTH = 1;
const uint16_t LOCATE_PAUSE_MS = 850;  // Pause between beeps
```

### 4.7 Power Management

#### 4.7.1 Sleep Strategy

Songbird uses the Notecarrier-F's ATTN-to-EN connection for deep sleep:

1. Host MCU (Cygnet) completes work cycle
2. Host saves state to Notecard payload
3. Host issues `card.attn` with `sleep` mode and wake conditions
4. Notecard pulls ATTN low, cutting power to Cygnet via EN pin
5. Notecard maintains ultra-low-power state (~8µA)
6. On wake condition (timer, motion, or **inbound command**), Notecard releases ATTN
7. Cygnet powers on, retrieves state from payload, resumes operation

**Wake Sources:**
- Periodic timer (configurable via `gps_interval_min`)
- Accelerometer motion detection (when `motion_wake_enabled`)
- **Inbound Notefile (`command.qi`)** — immediate wake on cloud command
- USB power connected (disable sleep for debugging)

**ATTN Configuration for Command Wake:**
```c
// Configure ATTN to wake on timer, motion, AND inbound commands
J *req = NoteNewRequest("card.attn");
JAddStringToObject(req, "mode", "sleep,motion,files");

// Watch the command.qi file for inbound commands
J *files = JCreateStringArray(new const char*[1]{"command.qi"}, 1);
JAddItemToObject(req, "files", files);

JAddNumberToObject(req, "seconds", sleepSeconds);

// Include state payload
if (payloadB64 != NULL) {
    JAddStringToObject(req, "payload", payloadB64);
}

NoteRequest(req);
```

This ensures the device wakes immediately when a command is sent from the cloud, even if it's in deep sleep.

#### 4.7.2 State Preservation

Device state is preserved across sleep cycles using the Notecard payload feature:

```c
// State structure saved to Notecard
struct SongbirdState {
    uint32_t boot_count;
    uint32_t last_sync_time;
    float last_pressure;  // For pressure delta alerts
    uint8_t current_mode;
    bool motion_since_last_report;
};

// Save state before sleep
void saveStateAndSleep(uint32_t sleep_seconds) {
    NotePayloadDesc payload = {0};
    NotePayloadAddSegment(&payload, "STATE", &state, sizeof(state));
    NotePayloadSaveAndSleep(&payload, sleep_seconds, NULL);
}

// Restore state after wake
bool restoreState() {
    NotePayloadDesc payload;
    if (NotePayloadRetrieveAfterSleep(&payload)) {
        NotePayloadGetSegment(&payload, "STATE", &state, sizeof(state));
        NotePayloadFree(&payload);
        return true;
    }
    return false;  // Cold boot, initialize fresh state
}
```

#### 4.7.3 Power Budget Estimates

| State | Current Draw | Duration (Transit Mode) | Energy |
|-------|--------------|------------------------|--------|
| Sleep (Notecard only) | ~10µA | 4.5 min (270s) | 0.75µAh |
| Active (no GPS) | ~15mA | 20s | 83µAh |
| Active (GPS acquisition) | ~50mA | 30s | 417µAh |
| **Cycle Total** | — | 5 min | ~500µAh |

**Battery Life Estimate (Transit Mode, 2000mAh battery):**
- Cycles per hour: 12
- Energy per hour: ~6mAh
- Estimated runtime: ~330 hours ≈ **14 days**

### 4.8 Firmware Flow

#### 4.8.1 Initialization Flow (Cold Boot)

```
┌─────────────────────────────────────────────────────────────────┐
│                         POWER ON                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Initialize peripherals (I2C, GPIO, Serial)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Initialize Notecard (I2C)                                      │
│  - NoteSetFnDefault...() callbacks                              │
│  - notecard.begin()                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Play power-on melody 🎵                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Attempt state restore from Notecard payload                    │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  State restored         │     │  Fresh boot             │
│  (warm wake)            │     │  (cold boot)            │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              │                               ▼
              │                 ┌─────────────────────────┐
              │                 │  Configure Notecard     │
              │                 │  - hub.set              │
              │                 │  - card.location.mode   │
              │                 │  - note.template(s)     │
              │                 └─────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Initialize BME280 sensor                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Fetch environment variables (env.get)                          │
│  Apply configuration updates                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check Notehub connection status                                │
│  Play connected melody if successful 🎵                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                        [ MAIN LOOP ]
```

#### 4.8.2 Main Loop Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN LOOP                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check for inbound commands (note.get on command.qi)            │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  Command received       │     │  No commands pending    │
│  - Parse command        │     │                         │
│  - Execute (play audio) │     │                         │
│  - Send acknowledgment  │     │                         │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Read BME280 sensor data                                        │
│  (temperature, humidity, pressure)                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Read battery voltage (card.voltage)                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check for motion since last wake (card.motion)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check alert conditions                                         │
│  - Temperature thresholds                                       │
│  - Humidity thresholds                                          │
│  - Pressure delta                                               │
│  - Low battery                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  Alert triggered        │     │  No alerts              │
│  - Play alert tone 🎵   │     │                         │
│  - Queue alert.qo note  │     │                         │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Request GPS location (if interval elapsed)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Queue track.qo note with sensor data                           │
│  Play chirp on success 🎵                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sync with Notehub (if sync interval elapsed or demo mode)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check for updated environment variables                        │
│  Apply any configuration changes                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Play entering sleep tone 🎵                                    │
│  Save state and enter sleep                                     │
│  (card.attn with sleep,motion,files mode)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   [ POWER OFF - SLEEPING ]
                              │
               (timer, motion, or INBOUND COMMAND wake)
                              │
                              ▼
                        [ POWER ON ]
```

---

## 5. Cloud Infrastructure

### 5.1 Notehub Configuration

#### 5.1.1 Project Setup

| Setting | Value |
|---------|-------|
| **Product UID** | `com.blues.songbird:demo` |
| **Product Name** | Songbird Demo Fleet |

#### 5.1.2 Fleet Organization

| Fleet UID | Name | Description |
|-----------|------|-------------|
| `fleet:sales-americas` | Sales Americas | North/South America sales team |
| `fleet:sales-emea` | Sales EMEA | Europe, Middle East, Africa sales |
| `fleet:sales-apac` | Sales APAC | Asia-Pacific sales team |
| `fleet:field-eng` | Field Engineering | Technical field engineering team |
| `fleet:partners` | Partners | Channel partner demo units |
| `fleet:development` | Development | Internal development and testing |

#### 5.1.3 Project-Level Environment Variable Defaults

```json
{
  "mode": "demo",
  "gps_interval_min": "5",
  "sync_interval_min": "15",
  "heartbeat_hours": "24",
  "temp_alert_high_c": "35.0",
  "temp_alert_low_c": "0.0",
  "humidity_alert_high": "80.0",
  "humidity_alert_low": "20.0",
  "pressure_alert_delta": "10.0",
  "voltage_alert_low": "3.4",
  "motion_sensitivity": "medium",
  "motion_wake_enabled": "true",
  "audio_enabled": "true",
  "audio_volume": "80",
  "audio_alerts_only": "false",
  "led_enabled": "true",
  "debug_mode": "false"
}
```

#### 5.1.4 Routes

**Route 1: AWS IoT Core (Primary)**

| Setting | Value |
|---------|-------|
| **Type** | AWS IoT Core |
| **Region** | us-east-1 (or preferred region) |
| **Topic** | `songbird/events` |
| **Notefiles** | `track.qo`, `alert.qo`, `command_ack.qo`, `_health.qo` |
| **Transform** | See JSONata below |

**JSONata Transform:**
```jsonata
{
  "device_uid": device,
  "serial_number": sn,
  "fleet": fleet,
  "event_type": file,
  "timestamp": when,
  "received": received,
  "body": body,
  "location": {
    "lat": best_lat,
    "lon": best_lon,
    "time": best_location_when,
    "source": best_location_type
  },
  "tower": {
    "lat": tower_lat,
    "lon": tower_lon
  }
}
```

### 5.2 AWS Infrastructure

#### 5.2.1 Service Architecture

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **IoT Core** | MQTT ingestion from Notehub | Topic: `songbird/events`, Rule: process-songbird-events |
| **Lambda** | Event processing and transformation | Runtime: Node.js 20.x, Memory: 256MB |
| **Timestream** | Time-series telemetry storage | Database: songbird, Table: telemetry |
| **DynamoDB** | Device metadata and state | Table: songbird-devices |
| **API Gateway** | REST API for dashboard | HTTP API with Lambda integration |
| **S3** | Dashboard static hosting | Bucket: songbird-dashboard |
| **CloudFront** | CDN for dashboard | Distribution for S3 bucket |
| **Cognito** | Authentication | User pool for dashboard access |
| **SNS** | Alert notifications | Topics for email/SMS alerts |

#### 5.2.2 Timestream Schema

**Database:** `songbird`  
**Table:** `telemetry`

| Column | Type | Description |
|--------|------|-------------|
| **Dimensions** | | |
| device_uid | VARCHAR | Notecard device UID |
| serial_number | VARCHAR | Human-readable device ID |
| fleet | VARCHAR | Fleet assignment |
| event_type | VARCHAR | Notefile name |
| **Measures** | | |
| temperature | DOUBLE | Temperature in °C |
| humidity | DOUBLE | Relative humidity in % |
| pressure | DOUBLE | Barometric pressure in hPa |
| voltage | DOUBLE | Battery voltage in V |
| motion | BOOLEAN | Motion detected flag |
| latitude | DOUBLE | GPS latitude |
| longitude | DOUBLE | GPS longitude |
| mode | VARCHAR | Operating mode |

#### 5.2.3 DynamoDB Schema

**Table:** `songbird-devices`

| Attribute | Type | Description |
|-----------|------|-------------|
| device_uid (PK) | String | Notecard device UID |
| serial_number | String | Human-friendly name (e.g., "SB-007") |
| fleet | String | Current fleet assignment |
| assigned_to | String | Person/team assignment |
| status | String | online, offline, alert |
| last_seen | Number | Unix timestamp of last event |
| last_location | Map | {lat, lon, time, source} |
| last_telemetry | Map | {temp, humidity, pressure, voltage} |
| current_mode | String | Current operating mode |
| firmware_version | String | Host firmware version |
| notecard_version | String | Notecard firmware version |
| created_at | Number | Device first seen timestamp |
| updated_at | Number | Last metadata update |

#### 5.2.4 Lambda Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `songbird-event-processor` | IoT Core Rule | Process incoming events, write to Timestream/DynamoDB |
| `songbird-api-devices` | API Gateway | CRUD operations for device metadata |
| `songbird-api-telemetry` | API Gateway | Query Timestream for telemetry data |
| `songbird-api-config` | API Gateway | Environment variable management via Notehub API |
| `songbird-api-commands` | API Gateway | Send commands to devices via Notehub API |
| `songbird-alert-handler` | IoT Core Rule (filtered) | Process alerts, send notifications via SNS |
| `songbird-command-ack-handler` | IoT Core Rule (filtered) | Process command acknowledgments, update command status |

#### 5.2.5 API Gateway Endpoints

**Base URL:** `https://api.songbird.blues.dev/v1`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/devices` | List all devices (filterable by fleet, status) |
| GET | `/devices/{device_uid}` | Get device details |
| PATCH | `/devices/{device_uid}` | Update device metadata (name, assignment) |
| GET | `/devices/{device_uid}/telemetry` | Get telemetry history |
| GET | `/devices/{device_uid}/location` | Get location history |
| GET | `/devices/{device_uid}/config` | Get current environment variables |
| PUT | `/devices/{device_uid}/config` | Update environment variables |
| **POST** | **`/devices/{device_uid}/commands`** | **Send command to device** |
| **GET** | **`/devices/{device_uid}/commands`** | **Get command history and acknowledgments** |
| GET | `/fleets` | List all fleets |
| GET | `/fleets/{fleet_uid}/devices` | List devices in fleet |
| PUT | `/fleets/{fleet_uid}/config` | Update fleet-wide configuration |
| **POST** | **`/fleets/{fleet_uid}/commands`** | **Send command to all devices in fleet** |
| GET | `/alerts` | List recent alerts |
| GET | `/stats` | Fleet statistics summary |

#### 5.2.6 Command API Details

**POST `/devices/{device_uid}/commands`**

Send a command to a specific device. The command is added to the device's `command.qi` Notefile via the Notehub API.

**Request Body:**
```json
{
  "cmd": "ping",
  "params": {}
}
```

**Supported Commands:**
| Command | Parameters | Description |
|---------|------------|-------------|
| `ping` | none | Play notification chime |
| `locate` | `duration_sec` (int, optional) | Play repeating locate pattern |
| `play_melody` | `melody` (string) | Play named melody |
| `test_audio` | `frequency` (int), `duration_ms` (int) | Play test tone |

**Response:**
```json
{
  "command_id": "cmd_abc123",
  "device_uid": "dev:864...",
  "cmd": "ping",
  "status": "queued",
  "queued_at": "2025-12-10T15:30:00Z"
}
```

**Implementation:**
The Lambda function calls the Notehub API to add a note to the device's `command.qi` Notefile:

```javascript
// Lambda: songbird-api-commands
const notehubResponse = await fetch(
  `https://api.notefile.net/v1/projects/${projectUid}/devices/${deviceUid}/notes/command.qi`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notehubToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: {
        cmd: command.cmd,
        params: command.params || {},
        command_id: commandId,
        sent_at: Date.now()
      }
    })
  }
);
```

### 5.3 Infrastructure as Code

The AWS infrastructure will be defined using AWS CDK (TypeScript):

```
songbird-infrastructure/
├── bin/
│   └── songbird.ts              # CDK app entry point
├── lib/
│   ├── songbird-stack.ts        # Main stack definition
│   ├── iot-construct.ts         # IoT Core resources
│   ├── storage-construct.ts     # Timestream + DynamoDB
│   ├── api-construct.ts         # API Gateway + Lambda
│   ├── dashboard-construct.ts   # S3 + CloudFront
│   └── auth-construct.ts        # Cognito
├── lambda/
│   ├── event-processor/         # Event processing function
│   ├── api-devices/             # Devices API function
│   ├── api-telemetry/           # Telemetry API function
│   ├── api-config/              # Config API function
│   └── alert-handler/           # Alert notification function
├── cdk.json
├── package.json
└── tsconfig.json
```

---

## 6. Dashboard Application

### 6.1 Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Framework** | React 18 + TypeScript | Modern, type-safe, large ecosystem |
| **Build Tool** | Vite | Fast development, optimized builds |
| **Styling** | Tailwind CSS | Utility-first, rapid UI development |
| **Components** | shadcn/ui | High-quality, accessible components |
| **Routing** | React Router v6 | Standard routing solution |
| **State Management** | TanStack Query (React Query) | Server state, caching, real-time updates |
| **Maps** | Mapbox GL JS | High-quality interactive maps |
| **Charts** | Recharts | React-native charting library |
| **Forms** | React Hook Form + Zod | Type-safe form handling |
| **Authentication** | AWS Amplify | Cognito integration |

### 6.2 Application Structure

```
songbird-dashboard/
├── public/
│   └── songbird-logo.svg
├── src/
│   ├── components/
│   │   ├── ui/                  # shadcn/ui components
│   │   ├── layout/
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Layout.tsx
│   │   ├── devices/
│   │   │   ├── DeviceCard.tsx
│   │   │   ├── DeviceList.tsx
│   │   │   └── DeviceStatus.tsx
│   │   ├── maps/
│   │   │   ├── FleetMap.tsx
│   │   │   ├── DeviceMarker.tsx
│   │   │   └── LocationTrail.tsx
│   │   ├── charts/
│   │   │   ├── TemperatureChart.tsx
│   │   │   ├── HumidityChart.tsx
│   │   │   ├── PressureChart.tsx
│   │   │   └── BatteryChart.tsx
│   │   ├── gauges/
│   │   │   ├── TemperatureGauge.tsx
│   │   │   ├── HumidityGauge.tsx
│   │   │   └── PressureGauge.tsx
│   │   └── config/
│   │       ├── ConfigPanel.tsx
│   │       └── EnvVarEditor.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx        # Fleet overview
│   │   ├── DeviceDetail.tsx     # Individual device view
│   │   ├── FleetView.tsx        # Fleet-specific view
│   │   ├── Alerts.tsx           # Alert history
│   │   └── Settings.tsx         # App settings
│   ├── hooks/
│   │   ├── useDevices.ts
│   │   ├── useTelemetry.ts
│   │   ├── useConfig.ts
│   │   └── useRealtime.ts
│   ├── api/
│   │   ├── client.ts            # API client setup
│   │   ├── devices.ts           # Device API calls
│   │   ├── telemetry.ts         # Telemetry API calls
│   │   └── config.ts            # Config API calls
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces
│   ├── utils/
│   │   └── formatters.ts        # Data formatting utilities
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── index.html
├── tailwind.config.js
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### 6.3 Dashboard Views

#### 6.3.1 Fleet Overview (Home)

The primary dashboard view showing all devices across the fleet.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  🐦 Songbird Dashboard                    [Fleet: All ▼]  [🔔 3]  [👤 User]│
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│ │     12     │ │     10     │ │     2      │ │     3      │ │     1      │ │
│ │  Devices   │ │   Online   │ │  Offline   │ │   Alerts   │ │ Low Battery│ │
│ │            │ │     🟢     │ │     🔴     │ │     ⚠️     │ │     🔋     │ │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘ │
├─────────────────────────────────────────────┬───────────────────────────────┤
│                                             │  Recent Activity              │
│        ┌─────────────────────────────┐      │  ───────────────────────────  │
│        │                             │      │                               │
│        │         MAP VIEW            │      │  📍 SB-007 location updated   │
│        │                             │      │     30.508, -97.678  •  2m    │
│        │      📍 SB-003              │      │                               │
│        │           📍 SB-007         │      │  🌡️ SB-003 temp alert: 36.2°C │
│        │  📍 SB-012   📍 SB-001      │      │     Threshold: 35.0°C  •  5m  │
│        │        📍 SB-015            │      │                               │
│        │                             │      │  ✅ SB-012 check-in           │
│        │                             │      │     Mode: transit  •  8m      │
│        │                             │      │                               │
│        │                             │      │  🔋 SB-009 low battery: 3.32V │
│        └─────────────────────────────┘      │     Threshold: 3.4V  •  15m   │
│                                             │                               │
│  [Satellite] [Street] [Dark]                │  [View All Activity →]        │
├─────────────────────────────────────────────┴───────────────────────────────┤
│  Fleet Summary                                                              │
│  ┌────────────────────┬────────────────────┬────────────────────┐           │
│  │  Sales Americas    │  Sales EMEA        │  Field Engineering │           │
│  │  4 devices  🟢 4   │  3 devices  🟢 2   │  5 devices  🟢 4   │           │
│  └────────────────────┴────────────────────┴────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 6.3.2 Device Detail View

Detailed view for a single device with real-time data, configuration, and command controls.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  🐦 Songbird Dashboard  ›  SB-007                      [⚙️ Config] [← Back]│
├─────────────────────────────────────────────────────────────────────────────┤
│  Device: SB-007  •  Fleet: Sales Americas  •  Assigned: Jane Smith         │
│  Status: 🟢 Online  •  Mode: transit  •  Last seen: 2 minutes ago          │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │                         [ MAP WITH TRAIL ]                          │   │
│  │                                                                     │   │
│  │                              📍 Current                             │   │
│  │                           ╱                                         │   │
│  │                         ○                                           │   │
│  │                       ╱                                             │   │
│  │                     ○───○───○  Trail (last 24h)                     │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│                      │                      │                               │
│    🌡️ Temperature     │    💧 Humidity       │    📊 Pressure               │
│                      │                      │                               │
│       23.4°C         │       48.2%          │      1013.2 hPa              │
│                      │                      │                               │
│    ▁▂▃▄▅▆▇█▇▆▅▄     │    ▅▅▅▆▆▆▅▅▄▄▃▃     │    ▅▅▅▅▄▄▄▄▃▃▃▃             │
│    [0-35°C]          │    [20-80%]          │    [Δ ±10 hPa]               │
│                      │                      │                               │
├──────────────────────┴──────────────────────┴───────────────────────────────┤
│                                                                             │
│  Historical Data (24h)                                     [24h][7d][30d]   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │     ── Temp (°C)    ─ ─ Humidity (%)    ···· Pressure (hPa)        │   │
│  │  35┤                                                                │   │
│  │    │      ╱╲                                                        │   │
│  │  25├────╱──╲─────────────────────────────────────────               │   │
│  │    │                                                                │   │
│  │  15┤                                                                │   │
│  │    └────────────────────────────────────────────────────────────    │   │
│  │     00:00    04:00    08:00    12:00    16:00    20:00    Now       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  📡 Command & Control                                                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                │
│  │   🔔 Ping      │  │   📍 Locate    │  │   🎵 Melody    │                │
│  │  Play Chime    │  │  Find Device   │  │   [Select ▼]   │                │
│  └────────────────┘  └────────────────┘  └────────────────┘                │
│                                                                             │
│  Last Command: ping • Status: ✅ Acknowledged • 5 minutes ago              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Device Info                                                                │
│  ┌───────────────────────────────────┬─────────────────────────────────┐   │
│  │  🔋 Battery: 3.92V (87%)          │  📶 Signal: -67 dBm (Good)      │   │
│  │  🔄 Firmware: 1.0.0               │  📡 Notecard: 7.2.2             │   │
│  │  🆔 UID: dev:864...               │  📍 GPS Fix: 120s ago           │   │
│  │  🔊 Audio: Enabled (80%)          │  💡 LED: Enabled                │   │
│  └───────────────────────────────────┴─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 6.3.3 Command Panel Component

The command panel provides instant device interaction:

```typescript
// components/commands/CommandPanel.tsx
interface CommandPanelProps {
  deviceUid: string;
  audioEnabled: boolean;
}

function CommandPanel({ deviceUid, audioEnabled }: CommandPanelProps) {
  const sendCommand = useSendCommand();
  const { data: lastCommand } = useLastCommand(deviceUid);

  return (
    <div className="command-panel">
      <h3>📡 Command & Control</h3>
      
      <div className="command-buttons">
        <Button 
          onClick={() => sendCommand({ deviceUid, cmd: 'ping' })}
          disabled={!audioEnabled}
        >
          🔔 Ping
        </Button>
        
        <Button 
          onClick={() => sendCommand({ deviceUid, cmd: 'locate', params: { duration_sec: 30 } })}
          disabled={!audioEnabled}
        >
          📍 Locate
        </Button>
        
        <MelodySelector 
          onSelect={(melody) => sendCommand({ deviceUid, cmd: 'play_melody', params: { melody } })}
          disabled={!audioEnabled}
        />
      </div>
      
      {lastCommand && (
        <div className="last-command">
          Last: {lastCommand.cmd} • 
          Status: {lastCommand.ack_status === 'ok' ? '✅' : '⏳'} •
          {formatRelativeTime(lastCommand.sent_at)}
        </div>
      )}
    </div>
  );
}
```

#### 6.3.3 Configuration Panel (Slide-out)

```
┌─────────────────────────────────────────┐
│  ⚙️ Device Configuration       [✕ Close]│
├─────────────────────────────────────────┤
│                                         │
│  Operating Mode                         │
│  ┌─────────────────────────────────┐    │
│  │  ○ Demo    (1 min GPS, instant) │    │
│  │  ● Transit (5 min GPS, 15 min)  │    │
│  │  ○ Storage (60 min GPS, 60 min) │    │
│  │  ○ Sleep   (motion wake only)   │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Custom Intervals                       │
│  GPS Interval:     [ 5 ] minutes        │
│  Sync Interval:    [ 15 ] minutes       │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Alert Thresholds                       │
│  Temp High:   [ 35.0 ] °C               │
│  Temp Low:    [ 0.0 ] °C                │
│  Humidity High: [ 80.0 ] %              │
│  Humidity Low:  [ 20.0 ] %              │
│  Pressure Δ:  [ 10.0 ] hPa              │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Audio Settings                         │
│  [✓] Audio Enabled                      │
│  Volume: ────●───── 80%                 │
│  [ ] Alerts Only                        │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  [ ] Debug Mode                         │
│  [✓] LED Enabled                        │
│                                         │
├─────────────────────────────────────────┤
│            [ Apply Changes ]            │
│                                         │
│  Changes will take effect on next sync  │
└─────────────────────────────────────────┘
```

#### 6.3.4 Demo Mode View

Simplified, high-contrast view optimized for customer presentations.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           🐦 SONGBIRD DEMO                     [Exit Demo] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌─────────────────────────────────┐                      │
│                    │                                 │                      │
│                    │         [ LARGE MAP ]           │                      │
│                    │                                 │                      │
│                    │              📍                 │                      │
│                    │         Device Location         │                      │
│                    │                                 │                      │
│                    └─────────────────────────────────┘                      │
│                                                                             │
│     ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│     │                 │  │                 │  │                 │          │
│     │    🌡️ 23.4°C    │  │    💧 48.2%     │  │  📊 1013 hPa   │          │
│     │   Temperature   │  │    Humidity     │  │    Pressure     │          │
│     │                 │  │                 │  │                 │          │
│     └─────────────────┘  └─────────────────┘  └─────────────────┘          │
│                                                                             │
│                       🔋 87%  •  📶 Strong  •  🟢 Connected                │
│                                                                             │
│                          Last Update: 30 seconds ago                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Real-time Updates

The dashboard supports real-time updates through polling (with WebSocket upgrade path):

```typescript
// hooks/useRealtime.ts
export function useDeviceTelemetry(deviceUid: string) {
  return useQuery({
    queryKey: ['telemetry', deviceUid],
    queryFn: () => fetchTelemetry(deviceUid),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 10_000,
  });
}

export function useFleetDevices(fleetUid?: string) {
  return useQuery({
    queryKey: ['devices', fleetUid],
    queryFn: () => fetchDevices(fleetUid),
    refetchInterval: 60_000, // Poll every minute
    staleTime: 30_000,
  });
}
```

---

## 7. Demo Scenarios

### 7.1 Demo Script: "First Connection" (5 minutes)

**Objective:** Show how quickly a Notecard-based device connects to the cloud.

**Setup:** Device powered off, dashboard open on Fleet Overview.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Unbox device, show components | "This is Songbird — Notecard, host MCU, environmental sensor, and battery" |
| 2 | Connect battery | "Just power it on — no provisioning, no SIM configuration" |
| 3 | Listen for power-on melody | 🎵 "That sound means it's starting up" |
| 4 | Wait for connected melody | 🎵 "And that melody means we're connected to the cloud" |
| 5 | Show device appearing on dashboard | "There it is — location, temperature, humidity, all flowing" |
| 6 | Point out time elapsed | "From power-on to cloud in under 3 minutes" |

**Key Message:** Cellular connectivity shouldn't be hard. Notecard makes it simple.

### 7.2 Demo Script: "Remote Configuration" (5 minutes)

**Objective:** Demonstrate remote device configuration without firmware updates.

**Setup:** Device running in Demo mode, dashboard open on Device Detail.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Show current configuration | "Right now it's in Demo mode, reporting every minute" |
| 2 | Open configuration panel | "Let's change it to Transit mode remotely" |
| 3 | Select Transit mode, apply | "This updates environment variables in Notehub" |
| 4 | Wait for device to sync | "On next sync, the device picks up the new config" |
| 5 | Show changed behavior | "Now it's reporting every 5 minutes — no firmware update" |
| 6 | Change alert threshold | "Let's also lower the temperature alert to trigger a demo" |
| 7 | Warm device, trigger alert | 🎵 "Hear that? Alert fired, and..." |
| 8 | Show alert on dashboard | "...instantly visible here with full context" |

**Key Message:** Deploy once, configure forever. No truck rolls for config changes.

### 7.3 Demo Script: "Environmental Monitoring" (5 minutes)

**Objective:** Show sensor integration and data visualization.

**Setup:** Dashboard on Device Detail with historical charts visible.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Show real-time gauges | "Temperature, humidity, pressure — updated continuously" |
| 2 | Point to historical charts | "Full history for trend analysis" |
| 3 | Explain BME280 integration | "Standard I2C sensor, Qwiic connector, minimal code" |
| 4 | Discuss cold chain use case | "Imagine this in a vaccine shipment or food transport" |
| 5 | Show pressure trending | "Pressure changes can indicate weather or altitude" |
| 6 | Trigger humidity alert | Breathe on sensor "Watch the humidity spike..." |
| 7 | Show alert notification | 🎵 "Audio alert, dashboard alert, full visibility" |

**Key Message:** Any sensor, any data, from anywhere in the world.

### 7.4 Demo Script: "Power Efficiency" (3 minutes)

**Objective:** Explain how Notecard enables long battery life.

**Setup:** Joulescope capture ready (pre-recorded), battery stats on dashboard.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Show battery voltage trend | "This device has been running for 2 weeks on a single charge" |
| 2 | Explain sleep modes | "The Notecard controls host power — true deep sleep" |
| 3 | Show Joulescope capture | "8 microamps in sleep, 50mA peak during GPS" |
| 4 | Discuss wake sources | "Timer wake, motion wake, fully configurable" |
| 5 | Compare to alternatives | "Try getting this battery life with WiFi or traditional cellular" |

**Key Message:** Notecard was designed from the ground up for battery-powered IoT.

### 7.5 Demo Script: "Fleet Management" (5 minutes)

**Objective:** Show scalability from one device to thousands.

**Setup:** Dashboard on Fleet Overview with multiple devices visible.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Show fleet map | "Here's our entire demo fleet across the country" |
| 2 | Filter by fleet | "Organized by sales region and team" |
| 3 | Show fleet statistics | "At a glance: online, offline, alerts, battery status" |
| 4 | Apply fleet-wide config | "Change settings for an entire fleet with one click" |
| 5 | Discuss Notehub scalability | "Same tools work for 10 devices or 10 million" |
| 6 | Show device detail drill-down | "But you can always drill down to individual devices" |

**Key Message:** Start small, scale infinitely. The infrastructure grows with you.

### 7.6 Demo Script: "Command & Control" (5 minutes)

**Objective:** Demonstrate bidirectional communication — cloud-to-device commands with instant response.

**Setup:** Device running (can be in pocket or across room), dashboard on Device Detail view.

| Step | Action | Talking Points |
|------|--------|----------------|
| 1 | Show command panel on dashboard | "The Notecard supports bidirectional communication" |
| 2 | Click "Ping" button | "Let's send a notification to the device..." |
| 3 | Listen for chime on device | 🎵 "Hear that? Command sent from cloud, executed instantly" |
| 4 | Show acknowledgment status | "The device confirms receipt — full round-trip visibility" |
| 5 | Click "Locate" button | "Now let's find the device — like Find My iPhone" |
| 6 | Listen for repeating pattern | 🎵🎵🎵 "It'll keep beeping until we stop it or it times out" |
| 7 | Explain wake behavior | "Even in deep sleep, commands wake the device immediately" |
| 8 | Discuss use cases | "Lost asset recovery, remote diagnostics, operator alerts" |

**Key Message:** True IoT is bidirectional. Notecard lets you reach out and touch your devices anywhere in the world.

**Variation — "Hidden Device" Demo:**
1. Before the demo, hide the Songbird somewhere in the room
2. "I've hidden a device somewhere — let's find it"
3. Click "Locate" and follow the sound
4. Great for trade show engagement!

---

## 8. Success Metrics

### 8.1 Technical Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Time to First Data** | < 3 minutes | Stopwatch from power-on to dashboard |
| **Battery Life (Transit)** | > 14 days | Real-world testing with 2000mAh battery |
| **Battery Life (Storage)** | > 60 days | Real-world testing with 2000mAh battery |
| **Sleep Current** | < 100µA | Joulescope measurement |
| **GPS Fix Time (warm)** | < 60 seconds | Average across test cycles |
| **Command Latency (Demo mode)** | < 5 seconds | Time from dashboard click to audio |
| **Command Latency (Periodic mode)** | < sync interval | Within configured sync period |
| **Dashboard Load Time** | < 2 seconds | Lighthouse performance audit |
| **API Response Time** | < 500ms | P95 latency monitoring |

### 8.2 Demo Effectiveness Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Demo Completion Rate** | > 95% | Demos completed without technical issues |
| **Customer Engagement Score** | > 8/10 | Post-demo survey |
| **Feature Recall** | > 3 features | Customer can name key Notecard capabilities |
| **Follow-up Request Rate** | > 50% | Customers requesting additional information |

### 8.3 Operational Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Device Availability** | > 99% | Devices online when needed for demos |
| **Mean Time to Repair** | < 4 hours | Time to resolve device issues |
| **Firmware Update Success** | > 99% | OTA updates completed successfully |

---

## 9. Implementation Plan

### 9.1 Phase Overview

| Phase | Duration | Focus | Key Deliverables |
|-------|----------|-------|------------------|
| **Phase 1** | Weeks 1-2 | Foundation | Hardware assembly, basic firmware, infrastructure setup |
| **Phase 2** | Weeks 3-4 | Core Features | Full firmware, data pipeline, basic dashboard |
| **Phase 3** | Weeks 5-6 | Polish | Audio system, UI refinement, documentation |
| **Phase 4** | Weeks 7-8 | Pilot | Internal testing, iteration, team training |

### 9.2 Phase 1: Foundation (Weeks 1-2)

#### Week 1

| Task | Owner | Deliverable |
|------|-------|-------------|
| Procure hardware components | Hardware | BOM items for 5 prototype units |
| Set up development environment | Firmware | PlatformIO project, dependencies installed |
| Create Notehub project | DevOps | Product UID, initial fleets, routes configured |
| Initialize AWS infrastructure | Backend | CDK project, IoT Core connected to Notehub |
| Scaffold dashboard application | Frontend | React app with routing, auth placeholder |

#### Week 2

| Task | Owner | Deliverable |
|------|-------|-------------|
| Assemble prototype hardware | Hardware | 3-5 working prototype units |
| Implement basic firmware | Firmware | Notecard connectivity, BME280 reading, basic loop |
| Complete Notehub → AWS pipeline | Backend | Events flowing to Timestream |
| Implement API endpoints | Backend | Basic device list and telemetry queries |
| Build fleet map component | Frontend | Map displaying device locations |

**Phase 1 Milestone:** Device sends sensor data to Notehub, visible on basic dashboard map.

### 9.3 Phase 2: Core Features (Weeks 3-4)

#### Week 3

| Task | Owner | Deliverable |
|------|-------|-------------|
| Implement Note templates | Firmware | Optimized track.qo and alert.qo templates |
| Add environment variable handling | Firmware | Remote configuration working |
| Implement power management | Firmware | ATTN-based sleep with state preservation |
| Build device detail view | Frontend | Full device page with telemetry display |
| Add historical charts | Frontend | Temperature, humidity, pressure over time |

#### Week 4

| Task | Owner | Deliverable |
|------|-------|-------------|
| Implement alert detection | Firmware | Threshold-based alerts, note creation |
| Add motion detection | Firmware | Wake-on-motion, motion flag in notes |
| Build configuration panel | Frontend | Environment variable editor |
| Implement config API | Backend | Notehub API integration for env vars |
| Real-time update polling | Frontend | Auto-refresh of device data |

**Phase 2 Milestone:** Full demo workflow functional — device configurable via dashboard.

### 9.4 Phase 3: Polish (Weeks 5-6)

#### Week 5

| Task | Owner | Deliverable |
|------|-------|-------------|
| Implement audio system | Firmware | Piezo driver, all melodies and tones |
| Audio configuration via env vars | Firmware | Remote audio enable/volume control |
| Design and print enclosures | Hardware | Branded enclosures for all units |
| Add fleet overview stats | Frontend | Summary cards, fleet filtering |
| Implement demo mode view | Frontend | Simplified presentation view |

#### Week 6

| Task | Owner | Deliverable |
|------|-------|-------------|
| Firmware optimization | Firmware | Power profiling, optimization passes |
| Dashboard UI polish | Frontend | Responsive design, dark mode, animations |
| Write demo scripts | Product | Complete scripts for all scenarios |
| Create user documentation | Product | Quick start guide, troubleshooting FAQ |
| Internal review | All | Team walkthrough, feedback collection |

**Phase 3 Milestone:** Production-quality demo units ready for internal pilot.

### 9.5 Phase 4: Pilot & Iterate (Weeks 7-8)

#### Week 7

| Task | Owner | Deliverable |
|------|-------|-------------|
| Distribute pilot units | Operations | 10 units to sales/FE team |
| Collect pilot feedback | Product | Structured feedback form, interviews |
| Bug fixes (priority) | All | Critical issues resolved |
| Demo rehearsals | Sales/FE | Team practices with real devices |

#### Week 8

| Task | Owner | Deliverable |
|------|-------|-------------|
| Implement feedback items | All | Top feedback items addressed |
| Final QA pass | QA | All features verified |
| Team training sessions | Product | Formal training for all users |
| Production deployment | DevOps | Dashboard on production infrastructure |
| Expand fleet | Operations | 20+ units for full team coverage |

**Phase 4 Milestone:** Songbird demo kit ready for customer-facing use.

### 9.6 Resource Requirements

| Role | Allocation | Responsibilities |
|------|------------|------------------|
| **Firmware Engineer** | 80% | Firmware development, power optimization |
| **Backend Engineer** | 60% | AWS infrastructure, API development |
| **Frontend Engineer** | 60% | Dashboard application |
| **Hardware/Operations** | 40% | Assembly, enclosures, logistics |
| **Product Manager** | 20% | Requirements, documentation, training |

### 9.7 Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| BME280 I2C conflicts | Low | Medium | Test early, use alternate address if needed |
| Power consumption higher than target | Medium | Medium | Iterative profiling, adjust modes if needed |
| GPS fix times too long | Medium | Low | Accept warm fix times, use tower location as fallback |
| Dashboard performance issues | Low | Medium | Implement pagination, optimize queries |
| Enclosure fit issues | Medium | Low | Prototype early, iterate on design |

---

## 10. Appendices

### Appendix A: Notecard API Reference

Key Notecard requests used in Songbird:

| Request | Purpose |
|---------|---------|
| `hub.set` | Configure Notehub connection mode and sync intervals |
| `hub.sync` | Force immediate sync with Notehub |
| `hub.status` | Check connection status |
| `card.location.mode` | Configure GPS acquisition |
| `card.location` | Get current location |
| `card.voltage` | Read battery voltage |
| `card.motion` | Read motion detection state |
| `card.attn` | Configure attention/sleep behavior |
| `env.get` | Read environment variables |
| `note.template` | Define Note templates |
| `note.add` | Add Notes to Notefiles |

### Appendix B: BME280 Sensor Specifications

| Parameter | Range | Accuracy |
|-----------|-------|----------|
| Temperature | -40°C to +85°C | ±1.0°C |
| Humidity | 0% to 100% RH | ±3% RH |
| Pressure | 300 hPa to 1100 hPa | ±1.0 hPa |
| I2C Address | 0x76 or 0x77 | Configurable via SDO pin |

### Appendix C: Piezo Buzzer Specifications

| Parameter | Value |
|-----------|-------|
| Type | Passive (requires PWM) |
| Operating Voltage | 3.0V - 5.0V |
| Resonant Frequency | 4.0 kHz ± 0.5 kHz |
| Sound Output | 85 dB @ 10cm |
| Operating Temperature | -20°C to +70°C |

### Appendix D: Serial Number Convention

Songbird devices use the following naming convention:

**Format:** `SB-XXX`

- **SB** = Songbird prefix
- **XXX** = Sequential 3-digit number (001-999)

Examples: SB-001, SB-042, SB-128

Serial numbers are configured in Notehub as the device `sn` (serial number) field and displayed in the dashboard for easy identification.

### Appendix E: Glossary

| Term | Definition |
|------|------------|
| **ATTN** | Attention pin on Notecard, used for wake/sleep control |
| **BME280** | Bosch environmental sensor (temp, humidity, pressure) |
| **Cygnet** | Blues STM32-based Feather MCU |
| **Environment Variable** | Key-value configuration stored in Notehub |
| **Fleet** | Logical grouping of devices in Notehub |
| **NBGL** | Notecard Midband Global LTE (Cat 1 bis) |
| **Note** | Individual data record sent to Notehub |
| **Notefile** | Collection of Notes (like a database table) |
| **Notecard** | Blues cellular/GPS modem module |
| **Notecarrier** | Carrier board for Notecard |
| **Notehub** | Blues cloud service for device management |
| **Qwiic** | SparkFun I2C connector system |
| **Template** | Schema definition for bandwidth-optimized Notes |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 10, 2025 | Brandon | Initial PRD |

---

*This document is the authoritative source for Songbird product requirements. All implementation decisions should reference this PRD.*