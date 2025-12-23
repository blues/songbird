# Songbird Dashboard

React-based fleet management dashboard for the Songbird sales demo platform.

## Features

- Fleet overview with device map
- Real-time device telemetry monitoring
- Historical data visualization with customizable time ranges
- Journey tracking with animated playback
- Location history with source filtering
- Remote device configuration
- Cloud-to-device command sending
- Alert management with acknowledgment workflows
- Cognito-based authentication with role-based access
- User management (Admin only): invite users, assign groups, assign devices
- User profile management with editable display name
- User preferences (temperature units, map style, default time range)

## Technology Stack

| Layer | Technology |
|-------|------------|
| Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| Components | shadcn/ui (Radix UI) |
| Routing | React Router v6 |
| State Management | TanStack Query (React Query) |
| Maps | Mapbox GL JS |
| Charts | Recharts |
| Authentication | AWS Amplify (Cognito) |

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

4. **Alternatively, use environment variable for Mapbox:**
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

The dashboard is deployed to S3 and served via CloudFront. After building:

1. **Deploy to S3:**
   ```bash
   aws s3 sync dist/ s3://songbird-dashboard-ACCOUNT_ID/ --delete
   ```

2. **Invalidate CloudFront cache:**
   ```bash
   aws cloudfront create-invalidation \
     --distribution-id DISTRIBUTION_ID \
     --paths "/*"
   ```

3. **Generate config.json from stack outputs:**
   ```bash
   # The infrastructure stack outputs the config as DashboardConfig
   # Copy this to your S3 bucket as config.json
   ```

## Views

### Fleet Dashboard

The main dashboard shows:
- Summary statistics (total devices, online/offline, alerts)
- Fleet map with device markers
- Recent activity feed
- Device card grid

### Device Detail

Individual device view includes:
- **Location section** with three tabs:
  - **Current**: Map showing current location or latest journey trail
  - **History**: Location history table with filtering by source (GPS, Cell, Wi-Fi, Triangulated)
  - **Journeys**: Journey selector and animated playback with speed controls (1x, 2x, 5x, 10x)
- Real-time gauges (temperature, humidity, pressure, battery)
- Historical telemetry charts (24h, 7d, 30d)
- Power monitoring charts (Mojo voltage, temperature, mAh)
- Command panel (ping, locate, play melody)
- Configuration panel (mode, thresholds, audio settings)
- Device information

## Operating Modes

The dashboard allows configuring devices into different operating modes, each optimized for specific use cases:

| Mode | GPS | Triangulation | Sync | Description |
|------|-----|---------------|------|-------------|
| **Demo** | Off | Enabled | Instant | For demonstrations - uses cell/Wi-Fi triangulation for location, syncs immediately |
| **Transit** | On (60s tracking) | Enabled | 15 min | For shipping/transport - full GPS tracking with velocity and bearing data |
| **Storage** | Off | Enabled | 60 min | For warehousing - minimal power consumption, hourly syncs |
| **Sleep** | Off | Off | N/A | Deep sleep with motion wake only |

### Location Tracking

The dashboard displays location data from multiple sources:

- **GPS Tracking (Transit mode only)**: High-precision GPS location with velocity (m/s), bearing (degrees), and distance traveled. Data is recorded when motion is detected and synced immediately via `_track.qo` events.

- **Triangulation (All modes except Sleep)**: Cell tower and Wi-Fi triangulation provides approximate location (50-200m accuracy) with faster time-to-fix and lower power consumption. Data arrives via `_geolocate.qo` events.

The location trail map shows pins with different colors/icons to indicate the location source, so users can understand the accuracy level of each data point.

### Transit Lock

Devices can be physically locked into transit mode by double-clicking the user button on the device. When transit lock is active:

- The mode badge displays an **amber background** with a **lock icon**
- The device operates in transit mode with full GPS tracking
- Remote mode changes via environment variables are blocked
- Lock state persists across device reboots

This visual indicator helps users understand when a device is in a locked shipping state and cannot be remotely reconfigured.

| Lock State | Badge Appearance |
|------------|------------------|
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
- **Preferences**: Temperature units (Celsius/Fahrenheit), map style, default time range
- **Notehub Status**: Connection status and route configuration
- **User Management** (Admin only): Invite new users, manage group assignments, assign devices to users

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

### Devices
- `GET /v1/devices` - List all devices
- `GET /v1/devices/{uid}` - Get device details
- `PATCH /v1/devices/{uid}` - Update device metadata
- `GET /v1/devices/{uid}/telemetry` - Get telemetry history
- `GET /v1/devices/{uid}/location` - Get location history
- `GET /v1/devices/{uid}/power` - Get Mojo power monitoring history
- `GET /v1/devices/{uid}/config` - Get device config
- `PUT /v1/devices/{uid}/config` - Update device config
- `GET /v1/devices/unassigned` - Get devices not assigned to any user

### Journeys & Location History
- `GET /v1/devices/{uid}/journeys` - List all journeys for a device
- `GET /v1/devices/{uid}/journeys/{journey_id}` - Get journey details with all points
- `GET /v1/devices/{uid}/locations` - Get full location history (all sources)

### Commands
- `GET /v1/devices/{uid}/commands` - Get command history for device
- `POST /v1/devices/{uid}/commands` - Send command to device
- `GET /v1/commands` - Get all commands across devices
- `DELETE /v1/commands/{command_id}` - Delete a command

### Alerts
- `GET /v1/alerts` - List all alerts (with optional filters)
- `GET /v1/devices/{uid}/alerts` - Get alerts for specific device
- `POST /v1/alerts/{alert_id}/acknowledge` - Acknowledge an alert

### Settings & Activity
- `GET /v1/settings` - Get user settings/preferences
- `PUT /v1/settings` - Update user settings/preferences
- `GET /v1/activity` - Get recent activity feed
- `GET /v1/notehub/status` - Get Notehub connection status

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
