# Songbird

**Blues Sales Demo Platform**

Songbird is a portable, battery-powered asset tracker and environmental monitor designed as a sales demonstration tool for the Blues sales and Field Engineering teams. It showcases the full capabilities of the Blues Notecard and Notehub ecosystem.

## Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              SONGBIRD DEVICE                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Cygnet    │  │   BME280    │  │   Piezo     │  │   LiPo      │        │
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
│                               NOTEHUB.IO                                     │
│         Routes events to AWS via HTTPS                                       │
└──────────────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS CLOUD                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  IoT Core   │─▶│   Lambda    │─▶│ Timestream  │◀─│ API Gateway │         │
│  └─────────────┘  └─────────────┘  │  DynamoDB   │  └──────┬──────┘         │
│                                    └─────────────┘         │                │
│  ┌─────────────┐  ┌─────────────┐                          │                │
│  │ CloudFront  │◀─│     S3      │                          │                │
│  └──────┬──────┘  └─────────────┘                          │                │
│         │                                                  │                │
│         └──────────────────┬───────────────────────────────┘                │
│                            │                                                │
│                   ┌────────┴────────┐                                       │
│                   │     Cognito     │                                       │
│                   └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SONGBIRD DASHBOARD                                  │
│    Fleet Map  │  Device Detail  │  Charts  │  Config  │  Commands            │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key Features

| Capability | Description |
|------------|-------------|
| **Instant Connectivity** | Power on → connected to cloud in under 3 minutes |
| **Environmental Monitoring** | Temperature, humidity, pressure via BME280 |
| **GPS/GNSS Tracking** | Real-time and historical location visualization |
| **Audio Feedback** | Piezo buzzer with melodies for status indication |
| **Remote Configuration** | Change device behavior via environment variables |
| **Command & Control** | Send commands from cloud, device responds instantly |
| **Low Power Operation** | Weeks of battery life with ATTN-based sleep |
| **Fleet Management** | Dashboard showing all demo units across teams |

## Project Structure

```
songbird/
├── songbird-firmware/        # STM32 firmware (PlatformIO)
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
|-----------|-------------|
| **Notecard** | Cell+WiFi (NBGL) with GPS/GNSS |
| **Host MCU** | Blues Cygnet (STM32L433) |
| **Carrier** | Notecarrier-F with ATTN→EN |
| **Sensor** | BME280 Qwiic breakout |
| **Audio** | Passive piezo buzzer |
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

See [songbird-firmware/README.md](songbird-firmware/README.md) for details.

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

See [songbird-infrastructure/README.md](songbird-infrastructure/README.md) for details.

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

See [songbird-dashboard/README.md](songbird-dashboard/README.md) for details.

## Operating Modes

| Mode | GPS Interval | Sync Interval | Use Case |
|------|--------------|---------------|----------|
| **demo** | 1 min | Immediate | Live customer demonstrations |
| **transit** | 5 min | 15 min | Asset in active transit |
| **storage** | 60 min | 60 min | Asset at rest, periodic check-in |
| **sleep** | Disabled | On motion | Long-term storage |

## Cloud-to-Device Commands

| Command | Description |
|---------|-------------|
| `ping` | Play notification chime |
| `locate` | Play repeating "find me" pattern |
| `play_melody` | Play specific melody |
| `test_audio` | Play test tone |
| `set_volume` | Adjust audio volume |

## Notefiles

| Notefile | Direction | Description |
|----------|-----------|-------------|
| `track.qo` | Outbound | Telemetry (temp, humidity, pressure, voltage) |
| `alert.qo` | Outbound | Alert notifications |
| `command_ack.qo` | Outbound | Command acknowledgments |
| `health.qo` | Outbound | Device health reports |
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

## License

Copyright (c) 2025 Blues Inc.
SPDX-License-Identifier: Apache-2.0
