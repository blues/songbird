# Songbird Dashboard

React-based fleet management dashboard for the Songbird sales demo platform.

## Features

- Fleet overview with device map
- Real-time device telemetry monitoring
- Historical data visualization
- Remote device configuration
- Cloud-to-device command sending
- Cognito-based authentication
- User profile management with editable display name

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
│   │   └── telemetry.ts
│   ├── components/
│   │   ├── charts/           # Telemetry charts
│   │   ├── commands/         # Command panel
│   │   ├── config/           # Configuration panel
│   │   ├── devices/          # Device cards and lists
│   │   ├── layout/           # Header, sidebar, layout
│   │   ├── maps/             # Fleet map, location trail
│   │   ├── profile/          # User profile components
│   │   └── ui/               # Base UI components (shadcn/ui)
│   ├── hooks/                # React Query hooks
│   │   ├── useCommands.ts
│   │   ├── useConfig.ts
│   │   ├── useDevices.ts
│   │   ├── useTelemetry.ts
│   │   └── useUserProfile.ts
│   ├── lib/                  # Utility libraries
│   ├── pages/                # Page components
│   │   ├── Commands.tsx
│   │   ├── Dashboard.tsx
│   │   └── DeviceDetail.tsx
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
- Location trail map (24h history)
- Real-time gauges (temperature, humidity, pressure, battery)
- Historical telemetry charts (24h, 7d, 30d)
- Power monitoring charts (Mojo voltage, temperature, mAh)
- Command panel (ping, locate, play melody)
- Configuration panel (mode, thresholds, audio settings)
- Device information

### Commands

Fleet-wide command management:
- Summary statistics (total, successful, pending, failed)
- Send commands to individual or all devices
- Command history table with status badges
- Filter commands by device
- Delete old commands from history

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

- `GET /v1/devices` - List all devices
- `GET /v1/devices/{uid}` - Get device details
- `GET /v1/devices/{uid}/telemetry` - Get telemetry history
- `GET /v1/devices/{uid}/location` - Get location history
- `GET /v1/devices/{uid}/power` - Get Mojo power monitoring history
- `GET /v1/devices/{uid}/config` - Get device config
- `PUT /v1/devices/{uid}/config` - Update device config
- `GET /v1/devices/{uid}/commands` - Get command history for device
- `POST /v1/devices/{uid}/commands` - Send command to device
- `GET /v1/commands` - Get all commands across devices
- `DELETE /v1/commands/{command_id}` - Delete a command

All API calls include the Cognito JWT token for authorization.

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

Copyright (c) 2025 Blues Inc.
