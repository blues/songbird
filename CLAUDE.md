# Songbird Project Guide

## Project Overview

Songbird is a portable, battery-powered IoT asset tracker and environmental monitor designed as a sales demonstration tool for Blues Inc. It showcases the full capabilities of the Blues Notecard and Notehub ecosystem through a complete end-to-end solution.

**Purpose**: Sales demonstration platform that shows instant connectivity, GPS tracking, environmental monitoring, remote configuration, and cloud-to-device commands.

## Architecture

```
┌─────────────────┐
│ Songbird Device │ ──── STM32 firmware + Notecard + BME280 + Buzzer
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Notehub      │ ──── Blues cloud router
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   AWS Cloud     │ ──── Lambda + DynamoDB + API Gateway + SNS
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Dashboard    │ ──── React SPA hosted on S3/CloudFront
└─────────────────┘
```

## Repository Structure

This is a monorepo with three main components:

### 1. songbird-firmware/
**STM32 embedded firmware (PlatformIO + FreeRTOS)**

```
src/
├── audio/          # Piezo buzzer control, melodies, audio feedback
├── notecard/       # Blues Notecard communication layer
├── sensors/        # BME280 environmental sensor (temp, humidity, pressure)
├── rtos/           # FreeRTOS task management and synchronization
├── core/           # Device configuration, state management, mode handling
├── commands/       # Cloud-to-device command processing
└── main.cpp        # Entry point, setup, loop
```

**Tech Stack:**
- Platform: STM32L433 (Blues Cygnet or Notecarrier CX)
- Framework: Arduino + FreeRTOS
- Libraries:
  - Blues Wireless Notecard (cellular/GPS communication)
  - Adafruit BME280 (environmental sensor)
  - SparkFun Qwiic Buzzer (audio feedback)
  - STM32duino FreeRTOS (task scheduling)
- Build: PlatformIO

**Key Concepts:**
- **Operating Modes**: demo, transit, storage, sleep (different power/sync profiles)
- **Transit Lock**: Single-click button to lock device in transit mode for shipping
- **Demo Lock**: Double-click button to lock device in demo mode for presentations
- **Lock Override**: Admin-only command to remotely clear transit or demo lock
- **External Panel-Mount Button**: LED pushbutton with visual feedback (LED on when locked)
- **ATTN-based Sleep**: Low-power operation using Notecard ATTN pin
- **Inbound Commands**: Received via `command.qi` notefile
- **Outbound Notefiles**: `track.qo`, `_track.qo`, `_geolocate.qo`, `alert.qo`, `command_ack.qo`, `health.qo`

### 2. songbird-infrastructure/
**AWS CDK infrastructure (TypeScript)**

```
lib/
├── songbird-stack.ts       # Main CDK stack
├── storage-construct.ts    # DynamoDB tables
├── auth-construct.ts       # Cognito user pools & groups
├── api-construct.ts        # HTTP API + Lambda functions
├── analytics-construct.ts  # PostHog integration
└── dashboard-construct.ts  # S3 + CloudFront for SPA

lambda/
├── api-ingest/             # Processes events from Notehub
├── api-devices/            # Device CRUD operations
├── api-telemetry/          # Fetch telemetry data
├── api-commands/           # Send commands to devices
├── api-alerts/             # Alert management (incl. bulk acknowledgement)
├── api-users/              # User management (incl. confirmation)
├── api-config/             # Fleet configuration
├── api-activity/           # Activity feed
├── api-settings/           # User settings
├── api-firmware/           # Firmware management
├── api-journeys/           # Journey management
├── api-notehub/            # Notehub API proxy
├── api-public-device/      # Public device sharing
├── api-visited-cities/     # Cities visited tracking
├── analytics/              # Analytics event processing
├── cognito-post-confirmation/  # Cognito triggers
└── shared/                 # Shared utilities
```

**Tech Stack:**
- IaC: AWS CDK (TypeScript)
- Compute: AWS Lambda (Node.js)
- Storage: DynamoDB
- Auth: Cognito with role-based groups (Admin, Sales, Field Engineering, Viewer)
- API: API Gateway HTTP API
- Hosting: S3 + CloudFront
- Notifications: SNS for alerts
- Build: esbuild for Lambda bundling

**Key Resources:**
- **Tables**: Devices, Telemetry, Alerts, Users, Commands, Config, ActivityFeed
- **User Groups**: Admin (full access), Sales (manage devices), FieldEngineering (view all), Viewer (read-only)
- **Notehub Integration**: HTTP route sends events to `/ingest` endpoint
- **Device Aliasing**: Maps stable serial numbers to potentially changing Notecard UIDs

### 3. songbird-dashboard/
**React dashboard (TypeScript + Vite)**

```
src/
├── pages/              # Route components (Fleet, Device, Alerts, Config, etc.)
├── components/         # Reusable UI components
│   ├── ui/            # shadcn/ui primitives (Button, Dialog, Card, etc.)
│   └── ...            # Domain components (DeviceCard, AlertList, MapView, etc.)
├── hooks/              # Custom React hooks (useDevices, useAuth, etc.)
├── api/                # API client functions (AWS Amplify)
├── contexts/           # React contexts (Auth, Settings)
├── types/              # TypeScript type definitions
├── lib/                # Utility functions
└── utils/              # Helper functions
```

**Tech Stack:**
- Framework: React 18 + TypeScript
- Build: Vite
- Styling: Tailwind CSS + shadcn/ui (Radix UI primitives)
- Auth: AWS Amplify + Cognito
- State: TanStack Query (React Query) for server state
- Routing: React Router v6
- Maps: Mapbox GL + react-map-gl
- Charts: Recharts
- Validation: Zod

**Key Features:**
- **Fleet Map**: Full-screen map with clustering, filtering, search
- **Device Detail**: Real-time telemetry, location history, journey playback
- **Journey Playback**: Animated GPS track visualization with road-snapping (Mapbox Map Matching API)
- **Alert Management**: Temperature threshold alerts with acknowledge/resolve workflow, bulk acknowledgement
- **Command & Control**: Send commands (ping, locate, play_melody, lock_override) to devices
- **User Management**: Admin can create users, assign to groups, manage permissions, confirm invited users
- **Device Assignment**: Assign devices to users for accountability
- **My Device**: Dedicated page for users to view their personally assigned device
- **Cities Visited**: Track and display cities visited by a device with visit counts
- **Wi-Fi Credentials**: Device owners can set Wi-Fi credentials that sync to the Notecard
- **Fleet Configuration**: Set default environment variables synced to Notehub
- **Notehub Integration**: Direct link to view device in Notehub console
- **Public Device Sharing**: Share device views via public URL without authentication
- **Responsive Design**: Mobile-friendly layouts

## Development Workflow

### Firmware Development

```bash
cd songbird-firmware

# Build
pio run

# Upload to device
pio run -t upload

# Monitor serial output
pio device monitor

# Debug build
pio run -e cygnet_debug
```

**Key Files:**
- `platformio.ini` - Project configuration, libraries, build flags
- `src/main.cpp` - Entry point
- `src/core/config.h` - Device configuration constants
- `src/rtos/tasks.cpp` - FreeRTOS task definitions

**Common Tasks:**
- Adding new sensor: Create in `src/sensors/`, add task in `src/rtos/`
- Adding new command: Handle in `src/commands/command_handler.cpp`
- Changing mode behavior: Modify `src/core/mode_manager.cpp`
- Adding melody: Update `src/audio/melodies.h`

### Infrastructure Development

```bash
cd songbird-infrastructure

# Install dependencies
npm install

# Build TypeScript
npm run build

# Preview changes
npm run diff

# Deploy to AWS
npm run deploy

# Destroy stack
npm run destroy
```

**Key Files:**
- `bin/songbird.ts` - CDK app entry point
- `lib/songbird-stack.ts` - Main stack definition
- `lambda/*/index.ts` - Lambda function handlers

**Common Tasks:**
- Adding new API: Add route in `api-construct.ts`, create Lambda in `lambda/`
- Adding new table: Define in `storage-construct.ts`
- Modifying ingest logic: Update `lambda/ingest/index.ts`
- Adding user permissions: Modify `auth-construct.ts` groups

### Dashboard Development

```bash
cd songbird-dashboard

# Install dependencies
npm install

# Start dev server (hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint
npm run lint
```

**Key Files:**
- `src/main.tsx` - App entry point
- `src/App.tsx` - Root component with routing
- `src/api/*.ts` - API client functions
- `public/config.json` - Runtime configuration (API endpoints, region, etc.)

**Common Tasks:**
- Adding new page: Create in `src/pages/`, add route in `App.tsx`
- Adding new API call: Create function in `src/api/`, use in component with TanStack Query
- Adding new component: Create in `src/components/`, use Tailwind + shadcn patterns
- Styling: Use Tailwind utility classes, extend in `tailwind.config.js`

## Key Concepts

### Device Modes

| Mode | Location | Sync Interval | Use Case |
|------|----------|---------------|----------|
| **demo** | Triangulation | Immediate | Live customer demonstrations |
| **transit** | GPS tracking (60s) | 15 min | Asset in active transit |
| **storage** | Triangulation | 60 min | Asset at rest |
| **sleep** | Disabled | On motion | Long-term storage |

### Journeys

A **journey** is a sequence of GPS tracking points during transit mode:
- Auto-assigned `journey` identifier (Unix timestamp)
- Includes velocity, bearing, distance, DOP (accuracy)
- Dashboard provides playback with road-snapping via Mapbox Map Matching API
- Can be deleted by Admin or device owner

### Notecard Swapping

Devices have stable serial numbers (e.g., `songbird01-bds`) independent of Notecard hardware:
- System tracks mapping between serial number and device UID
- When new Notecard sends data with existing serial number, system auto-detects swap
- All historical data preserved and accessible via serial number
- Activity feed records swap event

### Environment Variables (Notehub)

Device behavior is configured via Notehub environment variables:
- `mode`: Operating mode (demo, transit, storage, sleep)
- `alert_temp_high`: High temperature alert threshold (°C)
- `alert_temp_low`: Low temperature alert threshold (°C)
- `volume`: Audio volume (0-100)
- Dashboard can update these via Notehub API
- Device syncs changes and applies new configuration

### User Roles & Permissions

| Group | Permissions |
|-------|-------------|
| **Admin** | Full access: manage users, devices, alerts, config |
| **Sales** | Manage own devices, send commands, update config |
| **FieldEngineering** | View all devices, read-only access |
| **Viewer** | View assigned devices only, read-only |

## Testing & Debugging

### Firmware

- Serial monitor: `pio device monitor`
- Debug build: `pio run -e cygnet_debug` (enables verbose logging)
- LED indicators: Power, Notecard connection status
- Audio feedback: Melodies indicate state (power on, connected, command received)

### Infrastructure

- CloudWatch Logs: Check Lambda execution logs
- DynamoDB: Verify data in tables via AWS Console
- API Gateway: Test endpoints with curl or Postman
- Notehub: Verify events are being routed correctly

### Dashboard

- Browser DevTools: Network tab for API calls, Console for errors
- React Query DevTools: Available in dev mode for inspecting queries
- Amplify logging: Check auth flows and API calls
- Mapbox: Check browser console for map/geocoding errors

## Common Issues

### Firmware
- **Device won't connect**: Check product UID matches Notehub project
- **No GPS fix**: Ensure device is outdoors with clear sky view
- **Audio not working**: Check buzzer wiring, verify volume setting
- **Commands not received**: Verify `command.qi` notefile exists in Notehub

### Infrastructure
- **CDK deploy fails**: Check AWS credentials, IAM permissions
- **Lambda timeout**: Increase timeout in construct definition
- **API 403**: Verify Cognito token is valid and user has correct group membership
- **Ingest not working**: Check Notehub route configuration, verify endpoint URL

### Dashboard
- **Auth errors**: Verify `config.json` has correct Cognito IDs
- **API errors**: Check API endpoint URLs, network connectivity
- **Map not loading**: Verify Mapbox token in config, check browser console
- **Data not refreshing**: Check TanStack Query cache settings, network tab

## Deployment

### Production Deployment

1. **Infrastructure** (deploy first):
   ```bash
   cd songbird-infrastructure
   npm run deploy
   # Note CDK outputs (API URL, Cognito IDs, etc.)
   ```

2. **Dashboard**:
   ```bash
   cd songbird-dashboard
   # Update public/config.json with CDK outputs
   npm run build
   # Upload dist/ to S3 bucket (or use GitHub Actions)
   ```

3. **Firmware**:
   ```bash
   cd songbird-firmware
   pio run -t upload
   # Flash each device
   ```

### CI/CD

- Dashboard has GitHub Actions workflow for automated S3 deployment
- Triggered on push to main branch
- Invalidates CloudFront cache after deployment

## External Dependencies

### Blues
- **Notehub**: Cloud router for Notecard events (requires Notehub project)
- **Notecard**: Cellular/GPS hardware (MBGLW model recommended)

### AWS
- **Services**: Lambda, DynamoDB, API Gateway, Cognito, S3, CloudFront, SNS
- **Regions**: Configurable, default us-east-1

### Mapbox
- **GL JS**: Map rendering in dashboard
- **Geocoding API**: Address search
- **Map Matching API**: Road-snapping for journey playback
- Requires Mapbox access token

## Environment Setup

### Prerequisites

**Firmware:**
- PlatformIO Core or VS Code extension
- ST-Link programmer (for STM32 upload)

**Infrastructure:**
- Node.js 18+
- AWS CLI configured with credentials
- AWS CDK CLI: `npm install -g aws-cdk`

**Dashboard:**
- Node.js 18+
- Mapbox access token

### Configuration Files

**Infrastructure:**
- None required (CDK will prompt for stack name, region)

**Dashboard:**
- `public/config.json` - Created from CDK outputs
  ```json
  {
    "apiUrl": "https://xxx.execute-api.us-east-1.amazonaws.com",
    "region": "us-east-1",
    "userPoolId": "us-east-1_xxx",
    "userPoolClientId": "xxx",
    "mapboxToken": "pk.xxx"
  }
  ```

**Firmware:**
- Product UID set in `platformio.ini` build flags
- Notehub project created manually

## Code Style & Conventions

### Firmware (C++)
- Snake_case for functions, variables
- PascalCase for classes, structs
- ALL_CAPS for constants
- Modular structure: separate subsystems in folders
- FreeRTOS tasks for concurrent operations

### Infrastructure (TypeScript)
- PascalCase for classes, constructs
- camelCase for functions, variables
- Descriptive construct IDs for CloudFormation stack naming
- Lambda handlers in separate folders with index.ts

### Dashboard (TypeScript/React)
- PascalCase for components, types
- camelCase for functions, hooks
- Functional components with hooks (no class components)
- Custom hooks prefixed with `use`
- Tailwind for styling (avoid inline styles)
- shadcn/ui patterns for consistent UI

## Documentation

- **Main README**: `/README.md` - High-level overview, architecture
- **PRD**: `/songbird-prd.md` - Product requirements (detailed feature specs)
- **Firmware**: `/songbird-firmware/README.md`
- **Infrastructure**: `/songbird-infrastructure/README.md`
- **Dashboard**: `/songbird-dashboard/README.md`

## License

MIT License - Copyright (c) 2025 Blues Inc.
