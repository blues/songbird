# Songbird

**Blues Sales Demo Platform**

Songbird is a portable, battery-powered asset tracker and environmental monitor designed as a sales demonstration tool for the Blues sales and Field Engineering teams. It showcases the full capabilities of the Blues Notecard and Notehub ecosystem.

## Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              SONGBIRD DEVICE                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Cygnet / CX │  │   BME280    │  │   Piezo     │  │   LiPo      │        │
│  │   (Host)    │  │   Sensor    │  │   Buzzer    │  │   Battery   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│         └────────────────┴────────────────┴────────────────┘               │
│                          │                                                 │
│                 ┌────────┴────────┐                                        │
│                 │    Notecard     │                                        │
│                 │  + GPS/GNSS     │                                        │
│                 └────────┬────────┘                                        │
└──────────────────────────┼─────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               NOTEHUB                                        │
│                    Routes events to AWS via HTTP                             │
└──────────────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS CLOUD                                      │
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                    │
│  │ API Gateway │────▶│   Lambda    │────▶│  DynamoDB   │                    │
│  │  (Ingest)   │     │  (Ingest)   │     │  (Storage)  │                    │
│  └─────────────┘     └──────┬──────┘     └──────┬──────┘                    │
│                             │                   │                           │
│                             ▼                   │                           │
│                      ┌─────────────┐            │                           │
│                      │     SNS     │            │                           │
│                      │  (Alerts)   │            │                           │
│                      └─────────────┘            │                           │
│                                                 │                           │
│  ┌─────────────┐     ┌─────────────┐     ┌──────┴──────┐                    │
│  │ CloudFront  │────▶│     S3      │     │   Lambda    │                    │
│  │   (CDN)     │     │ (Dashboard) │     │   (APIs)    │                    │
│  └──────┬──────┘     └─────────────┘     └──────┬──────┘                    │
│         │                                       │                           │
│         │            ┌─────────────┐     ┌──────┴──────┐                    │
│         └───────────▶│   Cognito   │◀────│ API Gateway │                    │
│                      │   (Auth)    │     │ (HTTP API)  │                    │
│                      └─────────────┘     └─────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SONGBIRD DASHBOARD                                  │
│  Fleet Map │ Device Detail │ Charts │ Config │ Commands │ Alerts │ Settings │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key Features

| Capability | Description |
| --- | --- |
| **Instant Connectivity** | Power on → connected to cloud in under 3 minutes |
| **Environmental Monitoring** | Temperature, humidity, pressure via BME280 |
| **GPS/GNSS Tracking** | Real-time and historical location visualization |
| **Audio Feedback** | Piezo buzzer with melodies for status indication |
| **Remote Configuration** | Change device behavior via environment variables |
| **Command & Control** | Send commands from cloud, device responds instantly |
| **Low Power Operation** | Weeks of battery life with ATTN-based sleep |
| **Fleet Management** | Full-screen fleet map with filtering, search, and quick actions |
| **Alert Management** | Temperature threshold alerts with acknowledgment workflow |
| **User Management** | Role-based access with Admin, Sales, Field Engineering, Viewer groups |
| **Device Assignment** | Assign devices to users for accountability tracking |
| **Fleet Defaults** | Configure default settings per fleet, synced to Notehub environment variables |
| **Transit Lock** | Double-click button to lock device in transit mode for shipping |
| **Journey Tracking** | Record and playback GPS journeys with velocity and bearing data |
| **Location History** | View all location events with filtering by source (GPS, Cell, Wi-Fi) |
| **CI/CD Deployment** | Automated dashboard deployment via GitHub Actions |
| **Notecard Swapping** | Swap Notecard hardware while preserving device identity and all historical data |
| **Analytics & Feature Flags** | PostHog integration for usage analytics and remote feature control |
| **Public Device Sharing** | Share device views via public URL without authentication (audit logged) |

## Project Structure

```
songbird/
├── songbird-firmware/        # STM32 firmware
│   ├── src/
│   │   ├── audio/           # Audio/buzzer subsystem
│   │   ├── notecard/        # Notecard communication
│   │   ├── sensors/         # BME280 sensor handling
│   │   ├── rtos/            # FreeRTOS tasks and sync
│   │   ├── core/            # Configuration and state
│   │   ├── commands/        # Command handling
│   │   └── main.cpp
│   ├── platformio.ini
│   └── README.md
│
├── songbird-infrastructure/  # AWS CDK infrastructure
│   ├── bin/
│   ├── lib/
│   │   ├── songbird-stack.ts
│   │   ├── storage-construct.ts
│   │   ├── auth-construct.ts
│   │   ├── iot-construct.ts
│   │   ├── api-construct.ts
│   │   └── dashboard-construct.ts
│   ├── lambda/              # Lambda functions
│   └── README.md
│
├── songbird-dashboard/       # React dashboard
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── api/
│   └── README.md
│
├── songbird-prd.md          # Product Requirements Document
└── README.md                # This file
```

## Hardware

| Component | Description |
| --- | --- |
| **Notecard** | Cell+WiFi (NBGL) with GPS/GNSS |
| **Host MCU** | Blues Cygnet OR Notecarrier CX (STM32L433) |
| **Carrier** | Notecarrier-F with ATTN→EN OR Notecarrier CX |
| **Mojo** | Blues hardware accessory for battery power monitoring |
| **Sensor** | BME280 Qwiic breakout |
| **Audio** | Passive piezo buzzer |
| **Button** | [SparkFun Metal Pushbutton 16mm Green](https://www.sparkfun.com/metal-pushbutton-momentary-16mm-green.html) with LED |
| **Battery** | 3.7V LiPo, 2000mAh |

## Getting Started

### 1. Firmware

```bash
cd songbird-firmware

# Install PlatformIO CLI or use VS Code extension
# Build firmware
pio run

# Upload to device
pio run -t upload
```

See [README.md](./songbird-firmware/README.md) for details.

### 2. Infrastructure

```bash
cd songbird-infrastructure

# Install dependencies
npm install

# Configure AWS credentials
aws configure

# Deploy stack
npx cdk deploy --all
```

See [README.md](./songbird-infrastructure/README.md) for details.

### 3. Dashboard

```bash
cd songbird-dashboard

# Install dependencies
npm install

# Create config from CDK outputs
cp public/config.json.example public/config.json
# Edit config.json with values from CDK stack outputs

# Start development server
npm run dev
```

See [README.md](./songbird-dashboard/README.md) for details.

## Operating Modes

| Mode | Location Source | Sync Interval | Use Case |
| --- | --- | --- | --- |
| **demo** | Triangulation only | Immediate | Live customer demonstrations |
| **transit** | GPS tracking (60s) | 15 min | Asset in active transit |
| **storage** | Triangulation only | 60 min | Asset at rest, periodic check-in |
| **sleep** | Disabled | On motion | Long-term storage |

### GPS Tracking (Transit Mode Only)

Transit mode enables autonomous GPS tracking via `card.location.track`:
- **GPS sampling**: Every 60 seconds for accurate track resolution
- **Automatic tracking**: Notecard records location to `_track.qo` when motion detected
- **Track data**: Includes velocity (m/s), bearing (degrees), and distance traveled
- **Heartbeat**: Periodic updates (hourly) even when stationary
- **Immediate sync**: Track notes sync to cloud as soon as they're created

Other modes use cell tower/Wi-Fi triangulation for location, which is lower power but less precise.

### Journeys

A **journey** is a sequence of GPS tracking points recorded during a period of motion. The Notecard automatically assigns a `journey` identifier (Unix timestamp of when the journey started) to each `_track.qo` event.

- **Journey start**: When `jcount` = 1 (first GPS point of a new journey)
- **Journey end**: Automatic completion when:
  - A new journey starts (device detects new motion after stopping)
  - Device mode changes away from transit (to demo, storage, or sleep)
- **Journey data**: Each point includes lat/lon, velocity, bearing, distance, and accuracy (DOP)

The dashboard provides:
- **Journey list**: Browse all recorded journeys with duration, distance, and point count
- **Journey playback**: Animated map visualization with full playback controls:
  - **Road-snapped routes**: GPS traces are automatically snapped to roads using Mapbox Map Matching API
  - Play/pause with adjustable speed (1x, 2x, 5x, 10x) using real GPS velocity data
  - Step forward/back buttons for point-by-point navigation
  - Toggle between snapped and raw GPS views
  - Info overlay panel showing current point details
  - Reset button to return to journey start
- **Journey deletion**: Admin or device owner can delete journeys and all associated location points
- **Location history**: View all location events from any source with filtering
- **User preferences**: Distance units (km/miles) and temperature units (°C/°F) affect all displays

### Button Actions

The device has two buttons: an external panel-mount LED button and the internal Cygnet button (backup). Either button can trigger the following actions:

| Action | Result |
| --- | --- |
| **Single-click** | Toggle transit lock (amber badge, LED on) |
| **Double-click** | Toggle demo lock (green badge, LED on) |
| **Triple-click** | Toggle audio mute |

The panel-mount button's integrated LED illuminates when either transit lock or demo lock is engaged, providing visual feedback of the lock state.

### Transit Lock (Single-click)

Locks the device into transit mode for shipping:
- Saves current mode, switches to transit mode with GPS tracking
- Environment variable mode changes are blocked
- Dashboard shows amber lock icon next to mode
- Lock state persists across sleep cycles

### Demo Lock (Double-click)

Locks the device into demo mode for demonstrations:
- Saves current mode, switches to demo mode with continuous sync
- Environment variable mode changes are blocked
- Dashboard shows green lock icon next to mode
- Lock state persists across sleep cycles

## Notecard Swapping

Songbird supports swapping the Notecard hardware while preserving device identity and all historical data. This is useful when:

- Replacing a faulty Notecard
- Upgrading to a different Notecard model
- Moving a Notecard between devices for testing

### How It Works

1. **Serial Number**: Each device has a stable serial number (e.g., `songbird01-bds`) that identifies it in the dashboard and APIs
2. **Device UID**: The Notecard's unique identifier (e.g., `dev:351077454527360`) is tracked internally
3. **Device Aliasing**: The system maintains a mapping between serial numbers and their associated device UIDs

When a new Notecard sends data with an existing serial number:
- The system detects the swap automatically
- The old device UID is archived in the device history
- An activity feed entry is created to record the swap
- All historical data (telemetry, journeys, alerts, commands) is merged and accessible via the serial number

### Requirements

- The device firmware must set the serial number via `hub.set` with the `sn` field
- Events without a serial number are rejected by the ingest endpoint

## Cloud-to-Device Commands

| Command | Description |
| --- | --- |
| `ping` | Play notification chime |
| `locate` | Play repeating "find me" pattern |
| `play_melody` | Play specific melody |
| `test_audio` | Play test tone |
| `set_volume` | Adjust audio volume |

## Notefiles

| Notefile | Direction | Description |
| --- | --- | --- |
| `track.qo` | Outbound | Telemetry (temp, humidity, pressure, voltage) |
| `_track.qo` | Outbound | GPS tracking data (location, velocity, bearing, distance) |
| `_geolocate.qo` | Outbound | Triangulated location (cell tower/Wi-Fi) |
| `alert.qo` | Outbound | Alert notifications |
| `command_ack.qo` | Outbound | Command acknowledgments |
| `health.qo` | Outbound | Device health reports |
| `_log.qo` | Outbound | Mojo power monitoring data |
| `command.qi` | Inbound | Cloud-to-device commands |

## Demo Scenarios

### First Connection (5 min)
1. Unbox device, show components
2. Connect battery - hear power-on melody
3. Wait for connected melody (~2 min)
4. Show device appearing on dashboard
5. "From power-on to cloud in under 3 minutes"

### Remote Configuration (5 min)
1. Show current config (Demo mode)
2. Change to Transit mode via dashboard
3. Wait for device to sync
4. Show changed behavior
5. "No firmware update required"

### Command & Control (3 min)
1. Send ping command - hear chime
2. Send locate command - hear repeating beacon
3. Show command acknowledgment on dashboard
4. "Instant response from anywhere"

### Share Device View (2 min)
1. Copy public device URL: `/public/device/{serial_number}` or scan QR code on top of box.
2. Share link with customer (no login required)
3. Show read-only view with live telemetry
4. Customer clicks "Sign In" for full dashboard access
5. "Easy sharing for stakeholders"

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Blues Inc.
