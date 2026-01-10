# Songbird Dashboard

React-based fleet management dashboard for the Songbird sales demo platform.

## Features

- Fleet overview with device map
- Real-time device telemetry monitoring
- Historical data visualization with customizable time ranges
- Journey tracking with animated playback and power consumption metrics
- Journey data view showing filtered telemetry/power/health during journey timeframe
- Location history with source filtering
- Remote device configuration
- Cloud-to-device command sending
- Alert management with acknowledgment workflows
- Cognito-based authentication with role-based access
- User management (Admin only): invite users, assign groups, assign devices
- User profile management with editable display name
- User preferences (temperature units, time format, distance units, map style, default time range)
- Journey playback with Mapbox road-snapping for smooth route visualization
- Journey deletion (Admin/device owner only)
- Responsive UI with container queries for adaptive layouts
- GitHub Actions CI/CD for automated deployments
- **Notecard swapping**: Swap Notecard hardware while preserving device identity and history (serial number-based routing)

## Technology Stack

| Layer | Technology |
| --- | --- |
| Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| Components | shadcn/ui (Radix UI) |
| Routing | React Router v6 |
| State Management | TanStack Query (React Query) |
| Maps | Mapbox GL JS |
| Charts | Recharts |
| Authentication | AWS Amplify (Cognito) |
| Analytics & Feature Flags | PostHog |

## Project Structure

```
songbird-dashboard/
├── public/
│   ├── config.json           # Runtime configuration (created during deploy)
│   └── config.json.example   # Example configuration
├── src/
│   ├── api/                  # API client and endpoints
│   │   ├── client.ts
│   │   ├── commands.ts
│   │   ├── config.ts
│   │   ├── devices.ts
│   │   ├── journeys.ts
│   │   └── telemetry.ts
│   ├── components/
│   │   ├── charts/           # Telemetry charts
│   │   ├── commands/         # Command panel
│   │   ├── config/           # Configuration panel
│   │   ├── devices/          # Device cards and lists
│   │   ├── journeys/         # Journey map, selector, location history
│   │   ├── layout/           # Header, sidebar, layout
│   │   ├── maps/             # Fleet map, location trail
│   │   ├── profile/          # User profile components
│   │   └── ui/               # Base UI components (shadcn/ui)
│   ├── hooks/                # React Query hooks
│   │   ├── useAlerts.ts
│   │   ├── useCommands.ts
│   │   ├── useConfig.ts
│   │   ├── useDevices.ts
│   │   ├── useJourneys.ts
│   │   ├── useSettings.ts
│   │   ├── useTelemetry.ts
│   │   ├── useUserProfile.ts
│   │   └── useUsers.ts
│   ├── lib/                  # Utility libraries
│   ├── pages/                # Page components
│   │   ├── Alerts.tsx
│   │   ├── Commands.tsx
│   │   ├── Dashboard.tsx
│   │   ├── DeviceDetail.tsx
│   │   └── Settings.tsx
│   ├── contexts/             # React contexts
│   │   └── PreferencesContext.tsx
│   ├── hooks/                # React hooks
│   │   ├── useFeatureFlags.ts    # PostHog feature flags
│   ├── types/                # TypeScript interfaces
│   ├── utils/                # Formatters and helpers
│   ├── App.tsx               # Main app with routing
│   ├── main.tsx              # Entry point
│   └── index.css             # Global styles
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── vite.config.ts
```

## Prerequisites

- Node.js 18+
- npm or yarn
- Mapbox account (for map token)
- PostHog account (for analytics & feature flags)
- Deployed Songbird infrastructure (API URL, Cognito)

## Setup

1. **Install dependencies:**
```bash
   npm install
```

2. **Create configuration file:**
```bash
   cp public/config.json.example public/config.json
```

3. **Edit config.json with your values:**
```json
   {
     "apiUrl": "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com",
     "region": "us-east-1",
     "userPoolId": "us-east-1_XXXXXXXXX",
     "userPoolClientId": "XXXXXXXXXXXXXXXXXXXXXXXXXX",
     "mapboxToken": "pk.YOUR_MAPBOX_TOKEN"
   }
```

   > Get these values from the CloudFormation stack outputs after deploying the infrastructure.

4. **Set up PostHog (optional but recommended):**

   Create a `.env` file with your PostHog credentials:
```bash
   VITE_POSTHOG_KEY=phc_your_key_here
   VITE_POSTHOG_HOST=https://app.posthog.com
```

   > Get your API key from [PostHog Project Settings](https://app.posthog.com/settings/project).

5. **Alternatively, use environment variable for Mapbox:**
```bash
   export VITE_MAPBOX_TOKEN=pk.your_mapbox_token
```

## Development

```bash
# Start development server
npm run dev

# Open browser to http://localhost:3000
```

## Building

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment

### Automated Deployment (GitHub Actions)

The dashboard is automatically deployed to S3/CloudFront via GitHub Actions when changes are pushed to the `main` branch in the `songbird-dashboard/` directory.

**Required GitHub Secrets:**

| Secret | Description |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | AWS credentials for S3/CloudFront access |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for S3/CloudFront access |
| `API_URL` | API Gateway URL (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com`) |
| `USER_POOL_ID` | Cognito User Pool ID |
| `USER_POOL_CLIENT_ID` | Cognito User Pool Client ID |
| `MAPBOX_TOKEN` | Mapbox access token |
| `POSTHOG_KEY` | PostHog project API key |
| `POSTHOG_HOST` | PostHog host URL (default: `https://app.posthog.com`) |

The workflow creates `config.json` from these secrets during build.

### Manual Deployment

For manual deployments:

1. **Create config.json:**
```bash
   cp public/config.json.example public/config.json
   # Edit with your values
```

2. **Build:**
```bash
   npm run build
```

3. **Deploy to S3:**
```bash
   aws s3 sync dist/ s3://songbird-dashboard-ACCOUNT_ID/ --delete
```

4. **Invalidate CloudFront cache:**
```bash
   aws cloudfront create-invalidation \
     --distribution-id DISTRIBUTION_ID \
     --paths "/*"
```

## Views

### Fleet Dashboard

The main dashboard shows:
- Summary statistics (total devices, online/offline, alerts)
- Fleet map with device markers (click "See All" to open full-screen map)
- Recent activity feed showing:
  - ⚠️ Alerts (temperature, humidity, battery, motion)
  - 💓 Health events (boot, reboot, sync, USB connection)
  - 📡 Commands (ping, locate, play_melody with status)
  - 🗺️ Journey start/end events (with distance for completed journeys)
  - 🔄 Mode changes (Demo → Transit, etc.)
- Device list with status indicators

### Devices List

Dedicated devices view with:
- Fleet filter dropdown to filter by fleet
- Search filter to find devices by name, serial number, or location
- Device cards showing status, location, and quick actions

### Fleet Map (`/map`)

Full-screen map view with:
- **Collapsible device drawer** (left side):
  - Device count statistics (total, online, offline)
  - Fleet filter dropdown to show devices from specific fleets
  - Search filter to find devices by name, serial number, or location
  - Scrollable device list - click to fly to device location
- **Interactive map**:
  - Color-coded markers (green=online, red=offline)
  - Click marker for device popup with:
    - Device name, status, and mode
    - Location details with source indicator (GPS, Cell, Wi-Fi, Triangulation)
    - Latest telemetry (temperature, battery)
    - Quick action buttons: Ping, Locate, View Details

### Device Detail

Individual device view includes:
- **Location section** with three tabs:
  - **Current**: Map showing current location or latest journey trail
  - **History**: Location history table with filtering by source (GPS, Cell, Wi-Fi, Triangulated)
  - **Journeys**: Journey selector and animated playback with full controls:
    - **Road-snapped routes**: Automatically snaps GPS traces to roads using Mapbox Map Matching API
    - **Power consumption**: Shows total mAh consumed during the journey (requires Mojo power monitoring)
    - Speed controls (1x, 2x, 5x, 10x) with velocity-based animation
    - Step forward/back buttons for point-by-point navigation
    - Toggle between snapped and raw GPS views
    - Info overlay panel showing current point details (coordinates, speed, heading, accuracy, power)
    - Journey cards show distance in user's preferred unit (km or miles)
    - **Delete journeys** (Admin or device owner only) with confirmation dialog
    - Responsive card layout adapts to available space
    - **Journey Data view**: When a journey is selected, the Historical Data section becomes "Journey Data" and shows only telemetry, power, and health events that occurred during that journey's timeframe
- Real-time gauges (temperature, humidity, pressure, battery)
- Historical telemetry charts (24h, 7d, 30d)
- Power monitoring charts (Mojo voltage, temperature, mAh)
- Command panel (ping, locate, play melody)
- Configuration panel (mode, thresholds, audio settings) with temperature display in user's preferred unit
- Device information

## Operating Modes

The dashboard allows configuring devices into different operating modes, each optimized for specific use cases:

| Mode | GPS | Triangulation | Sync | Description |
| --- | --- | --- | --- | --- |
| **Demo** | Off | Enabled | Instant | For demonstrations - uses cell/Wi-Fi triangulation for location, syncs immediately |
| **Transit** | On (60s tracking) | Enabled | 15 min | For shipping/transport - full GPS tracking with velocity and bearing data |
| **Storage** | Off | Enabled | 60 min | For warehousing - minimal power consumption, hourly syncs |
| **Sleep** | Off | Off | N/A | Deep sleep with motion wake only |

### Location Tracking

The dashboard displays location data from multiple sources:

- **GPS Tracking (Transit mode only)**: High-precision GPS location with velocity (m/s), bearing (degrees), and distance traveled. Data is recorded when motion is detected and synced immediately via `_track.qo` events.

- **Triangulation (All modes except Sleep)**: Cell tower and Wi-Fi triangulation provides approximate location (50-200m accuracy) with faster time-to-fix and lower power consumption. Data arrives via `_geolocate.qo` events.

The location trail map shows pins with different colors/icons to indicate the location source, so users can understand the accuracy level of each data point.

### Battery Monitoring

Battery voltage is displayed in the dashboard from device metadata rather than telemetry readings. The data comes from:

- **Mojo power monitor** (`_log.qo`): If present, provides voltage, temperature, and mAh consumed
- **Notecard health events** (`_health.qo`): Provides voltage and voltage mode as a fallback

This approach reduces data transfer (battery is sampled by the Notecard, not sent with every telemetry reading) and provides accurate LiPo battery tracking with the Notecard's built-in discharge curve.

### Transit Lock

Devices can be physically locked into transit mode by double-clicking the user button on the device. When transit lock is active:

- The mode badge displays an **amber background** with a **lock icon**
- The device operates in transit mode with full GPS tracking
- Remote mode changes via environment variables are blocked
- Lock state persists across device reboots

This visual indicator helps users understand when a device is in a locked shipping state and cannot be remotely reconfigured.

| Lock State | Badge Appearance |
| --- | --- |
| Unlocked | Gray badge with mode name (e.g., "Demo", "Transit") |
| Locked | Amber badge with lock icon and mode name |

### Commands

Fleet-wide command management:
- Summary statistics (total, successful, pending, failed)
- Send commands to individual or all devices
- Command history table with status badges
- Filter commands by device
- Delete old commands from history

### Alerts

Alert management dashboard:
- Summary statistics (active, acknowledged, resolved)
- Alert list with severity badges (critical, warning, info)
- Alert acknowledgment workflow
- Filter by status, severity, and device
- Alert details with timestamp and source

### Settings

Application and user settings (Admin users see additional options):
- **Preferences**:
  - Temperature units (Celsius/Fahrenheit) - affects all temperature displays and config sliders
  - Time format (12h/24h)
  - Distance units (Kilometers/Miles) - affects journey distances and speed displays
  - Map style (Street/Satellite)
  - Default chart time range
- **Notehub Status**: Connection status and route configuration
- **Fleet Defaults** (Admin only): Configure default settings per fleet (mode, intervals, alert thresholds, features). Settings are saved to DynamoDB and synced to Notehub as fleet environment variables, applying to all devices on their next sync.
- **User Management** (Admin only): Invite new users, manage group assignments, assign devices to users

## Analytics & Feature Flags (PostHog)

The dashboard uses [PostHog](https://posthog.com) for product analytics and feature flag management.

### Features

- **Page view tracking**: Automatic tracking of all page navigations
- **User identification**: Users are identified by their Cognito sub with email, name, and group properties
- **Feature flags**: Control feature visibility remotely without deployments
- **Event tracking**: Custom events for key user actions

### Feature Flags

Feature flags are managed in the [PostHog dashboard](https://app.posthog.com/feature_flags). Current flags:

| Flag | Description |
| --- | --- |
| `analytics` | Enable the Analytics page with natural language queries |

### Targeting Users

You can target feature flags by user properties:

| Property | Description | Example |
| --- | --- | --- |
| `email` | User's email address | `admin@blues.com` |
| `group` | Primary Cognito group | `Admin` |
| `groups` | All Cognito groups | `["Admin", "Sales"]` |

Example: Enable `analytics` flag for all Admin users by adding a condition: `group equals "Admin"`.

### Local Development

PostHog is optional for local development. If `VITE_POSTHOG_KEY` is not set, analytics are disabled but the app functions normally. Feature flags will default to `false`.

## Authentication

The dashboard uses AWS Cognito for authentication:

- Users must sign in before accessing the dashboard
- User pools are created by the infrastructure stack
- Groups: Admin, Sales, FieldEngineering, Viewer

### User Profile

Users can customize their display name via the profile menu:

1. Click the user icon in the header
2. Select "Edit Profile" from the dropdown
3. Enter a display name and save

The display name is stored in the Cognito `name` attribute and shown in the header instead of the username/ID.

## API Integration

The dashboard communicates with the Songbird API via:

**Note**: All device-specific endpoints use the device's `serial_number` as the path parameter. This enables Notecard hardware swapping while preserving device identity and history. The API automatically merges data from all Notecards that have been associated with a device.

### Devices
- `GET /v1/devices` - List all devices
- `GET /v1/devices/{serial_number}` - Get device details
- `PATCH /v1/devices/{serial_number}` - Update device metadata
- `GET /v1/devices/{serial_number}/telemetry` - Get telemetry history
- `GET /v1/devices/{serial_number}/location` - Get location history
- `GET /v1/devices/{serial_number}/power` - Get Mojo power monitoring history
- `GET /v1/devices/{serial_number}/health` - Get device health history
- `GET /v1/devices/{serial_number}/config` - Get device config
- `PUT /v1/devices/{serial_number}/config` - Update device config
- `GET /v1/devices/unassigned` - Get devices not assigned to any user

### Journeys & Location History
- `GET /v1/devices/{serial_number}/journeys` - List all journeys for a device
- `GET /v1/devices/{serial_number}/journeys/{journey_id}` - Get journey details with all points
- `DELETE /v1/devices/{serial_number}/journeys/{journey_id}` - Delete a journey (Admin or device owner only)
- `POST /v1/devices/{serial_number}/journeys/{journey_id}/match` - Trigger Mapbox road-snapping for a journey
- `GET /v1/devices/{serial_number}/locations` - Get full location history (all sources)

### Commands
- `GET /v1/devices/{serial_number}/commands` - Get command history for device
- `POST /v1/devices/{serial_number}/commands` - Send command to device
- `GET /v1/commands` - Get all commands across devices
- `DELETE /v1/commands/{command_id}` - Delete a command

### Alerts
- `GET /v1/alerts` - List all alerts (with optional `serial_number` filter)
- `POST /v1/alerts/{alert_id}/acknowledge` - Acknowledge an alert

### Settings & Activity
- `GET /v1/settings` - Get user settings/preferences
- `PUT /v1/settings` - Update user settings/preferences
- `GET /v1/activity` - Get recent activity feed (alerts, health, commands, journeys, mode changes)
- `GET /v1/notehub/status` - Get Notehub connection status
- `GET /v1/settings/fleet-defaults` - List all fleet defaults (Admin only)
- `GET /v1/settings/fleet-defaults/{fleet}` - Get fleet defaults
- `PUT /v1/settings/fleet-defaults/{fleet}` - Update fleet defaults and sync to Notehub (Admin only)

### User Management (Admin only)
- `GET /v1/users` - List all users
- `GET /v1/users/{userId}` - Get user details
- `POST /v1/users` - Invite new user
- `GET /v1/users/groups` - List available groups
- `PUT /v1/users/{userId}/groups` - Update user group memberships
- `PUT /v1/users/{userId}/device` - Assign device to user

All API calls include the Cognito JWT token for authorization.

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

Copyright (c) 2025 Blues Inc.
