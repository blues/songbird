# Songbird Cloud Infrastructure

AWS CDK infrastructure for the Songbird demo platform. This deploys all cloud resources needed to receive, store, and serve device telemetry data.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NOTEHUB                                        │
│                                  │                                          │
│                         HTTP Route (POST)                                   │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              AWS CLOUD                                       │
│                                                                              │
│                         ┌─────────────┐     ┌─────────────────────────────┐  │
│                         │ API Gateway │────▶│  DynamoDB (telemetry +      │  │
│                         │  (Ingest)   │     │  device metadata)           │  │
│                         └──────┬──────┘     └─────────────────────────────┘  │
│                                │                         ▲                   │
│                                ▼                         │                   │
│                         ┌─────────────┐           ┌──────┴──────┐            │
│                         │     SNS     │           │   Lambda    │            │
│                         │  (Alerts)   │           │   (APIs)    │            │
│                         └─────────────┘           └──────┬──────┘            │
│                                                          │                   │
│  ┌─────────────┐     ┌─────────────┐           ┌─────────┴───────┐           │
│  │  CloudFront │────▶│     S3      │           │   API Gateway   │           │
│  │   (CDN)     │     │ (Dashboard) │           │   (HTTP API)    │           │
│  └─────────────┘     └─────────────┘           └─────────────────┘           │
│         │                                             │                      │
│         │            ┌─────────────┐                  │                      │
│         └───────────▶│   Cognito   │◀─────────────────┘                      │
│                      │   (Auth)    │                                         │
│                      └─────────────┘                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Node.js** 18.x or later
3. **AWS CDK CLI** installed globally:
   ```bash
   npm install -g aws-cdk
   ```
4. **Notehub Project** created at [notehub.io](https://notehub.io)
5. **Notehub API Token** for programmatic access

## Project Structure

```
songbird-infrastructure/
├── bin/
│   └── songbird.ts              # CDK app entry point
├── lib/
│   ├── songbird-stack.ts        # Main stack definition
│   ├── storage-construct.ts     # DynamoDB tables
│   ├── auth-construct.ts        # Cognito User Pool
│   ├── api-construct.ts         # API Gateway + Lambda
│   └── dashboard-construct.ts   # S3 + CloudFront
├── lambda/
│   ├── api-ingest/              # Event ingest from Notehub HTTP route
│   ├── api-devices/             # Devices API
│   ├── api-telemetry/           # Telemetry queries API
│   ├── api-journeys/            # Journeys and location history API
│   ├── api-commands/            # Commands API
│   ├── api-config/              # Configuration API
│   ├── api-alerts/              # Alerts API
│   ├── api-activity/            # Activity feed API
│   ├── api-settings/            # User settings/preferences API
│   ├── api-users/               # User management API (Admin)
│   └── api-notehub/             # Notehub status API
├── cdk.json                     # CDK configuration
├── package.json
└── tsconfig.json
```

## Setup

### 1. Install Dependencies

```bash
cd songbird-infrastructure
npm install
```

### 2. Configure AWS Credentials

Ensure your AWS credentials are configured:

```bash
aws configure
# Or use environment variables:
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1
```

### 3. Bootstrap CDK (First Time Only)

If this is your first time using CDK in this AWS account/region:

```bash
cdk bootstrap
```

### 4. Set Notehub Project UID

You can set the Notehub Project UID via context:

```bash
# Option 1: Command line
cdk deploy -c notehubProjectUid=com.blues.songbird

# Option 2: Add to cdk.json
{
  "context": {
    "notehubProjectUid": "com.blues.songbird"
  }
}
```

## Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

To watch for changes during development:

```bash
npm run watch
```

## Deploy

### Preview Changes

See what will be deployed without making changes:

```bash
cdk diff
```

### Deploy All Resources

```bash
cdk deploy
```

Or with explicit project UID:

```bash
cdk deploy -c notehubProjectUid=com.blues.songbird
```

### Deploy with Approval

For production deployments, require approval for security-sensitive changes:

```bash
cdk deploy --require-approval broadening
```

## Post-Deployment Setup

### 1. Configure Notehub API Token

After deployment, you need to add your Notehub API token to AWS Secrets Manager:

```bash
# Get your API token from Notehub (Project Settings > API)
aws secretsmanager put-secret-value \
  --secret-id songbird/notehub-api-token \
  --secret-string '{"token":"your-notehub-api-token-here"}'
```

### 2. Configure Notehub Route

Create an HTTP route in Notehub to send events to the API Gateway ingest endpoint:

1. Go to your Notehub project → **Routes**
2. Click **Create Route** and select **General HTTP/HTTPS Request/Response**
3. Configure the route:
   - **Name**: `Songbird AWS Ingest`
   - **URL**: Use the `IngestUrl` from the CDK deployment outputs (e.g., `https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/v1/ingest`)
   - **HTTP Method**: `POST`
   - **HTTP Headers**: Add `Content-Type: application/json`
4. Under **Notefiles**, select:
   - `track.qo` - Telemetry data
   - `_track.qo` - GPS tracking data (location, velocity, bearing) - Transit mode only
   - `alert.qo` - Alert events
   - `command_ack.qo` - Command acknowledgments
   - `health.qo` - Device health
   - `_log.qo` - Mojo power monitoring data
   - `_geolocate.qo` - Triangulation location data
   - `_session.qo` - Session info with firmware versions
5. Under **Data**, leave as **All Data** (no JSONata transform needed - the Lambda handles the Notehub event format directly)
6. Click **Create Route**

**Note**: The `_log.qo` Notefile contains Mojo power monitoring data (voltage, temperature, milliamp_hours) when enabled via the `_log` environment variable set to `power`.

**Note**: The `_geolocate.qo` Notefile contains cell tower and Wi-Fi triangulation results when triangulation is enabled via `card.triangulate`. This provides location data even when GPS is disabled.

**Note**: The `_session.qo` Notefile contains session information including host firmware version (`firmware_host`), Notecard firmware version (`firmware_notecard`), and Notecard SKU (`sku`). This data is extracted and stored with the device metadata.

**Testing the Route**: After creating the route, you can test it by clicking the route and selecting **Test Route**. Send a sample event and verify it returns a 200 status.

### 3. Create Initial Cognito Users

Create admin users for the dashboard:

```bash
# Create a user (use single line to avoid parsing issues)
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username admin@yourcompany.com --user-attributes Name=email,Value=admin@yourcompany.com Name=name,Value="Admin User" --temporary-password "TempPass123!"
```

### 4. Note the Outputs

After deployment, CDK will output important values:

```
Outputs:
SongbirdStack.ApiUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/
SongbirdStack.IngestUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/v1/ingest
SongbirdStack.DashboardUrl = https://xxxxxxxxxx.cloudfront.net
SongbirdStack.UserPoolId = us-east-1_xxxxxxxxx
SongbirdStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **IngestUrl**: Use this for configuring the Notehub HTTP route
- **ApiUrl**: Base URL for dashboard API calls
- **DashboardUrl**: URL to access the web dashboard

Save these for configuring the dashboard application.

## API Endpoints

Base URL: `https://<api-id>.execute-api.<region>.amazonaws.com`

### Event Ingest (Notehub Route)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/ingest` | Receive events from Notehub HTTP route (no auth) |

### Dashboard APIs (Cognito Auth Required)

#### Devices
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/devices` | List all devices |
| GET | `/v1/devices/{device_uid}` | Get device details |
| PATCH | `/v1/devices/{device_uid}` | Update device metadata |
| GET | `/v1/devices/{device_uid}/telemetry` | Get telemetry history |
| GET | `/v1/devices/{device_uid}/location` | Get location history |
| GET | `/v1/devices/{device_uid}/power` | Get Mojo power monitoring history |
| GET | `/v1/devices/unassigned` | Get devices not assigned to any user |

#### Journeys & Location History
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/devices/{device_uid}/journeys` | List all journeys for device |
| GET | `/v1/devices/{device_uid}/journeys/{journey_id}` | Get journey details with all points |
| GET | `/v1/devices/{device_uid}/locations` | Get full location history (all sources) |

#### Commands
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/devices/{device_uid}/commands` | Get command history for device |
| POST | `/v1/devices/{device_uid}/commands` | Send command to device |
| GET | `/v1/commands` | Get all commands across devices (optional `device_uid` query param) |
| DELETE | `/v1/commands/{command_id}` | Delete a command (requires `device_uid` query param) |

#### Configuration
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/devices/{device_uid}/config` | Get device configuration |
| PUT | `/v1/devices/{device_uid}/config` | Update device configuration |
| PUT | `/v1/fleets/{fleet_uid}/config` | Update fleet configuration |

#### Alerts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/alerts` | List all alerts (with optional filters) |
| GET | `/v1/devices/{device_uid}/alerts` | Get alerts for specific device |
| POST | `/v1/alerts/{alert_id}/acknowledge` | Acknowledge an alert |

#### Settings & Activity
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/settings` | Get user settings/preferences |
| PUT | `/v1/settings` | Update user settings/preferences |
| GET | `/v1/activity` | Get recent activity feed |
| GET | `/v1/notehub/status` | Get Notehub connection status |

#### User Management (Admin only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/users` | List all users |
| GET | `/v1/users/{userId}` | Get user details |
| POST | `/v1/users` | Invite new user (creates Cognito user, sends invite email) |
| GET | `/v1/users/groups` | List available Cognito groups |
| PUT | `/v1/users/{userId}/groups` | Update user group memberships |
| PUT | `/v1/users/{userId}/device` | Assign device to user (one device per user) |

Dashboard API endpoints require a valid Cognito JWT token in the `Authorization` header.

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run watch` | Watch for changes and compile |
| `cdk synth` | Generate CloudFormation template |
| `cdk diff` | Compare deployed stack with current state |
| `cdk deploy` | Deploy stack to AWS |
| `cdk destroy` | Remove all deployed resources |

## Monitoring

### CloudWatch Logs

Lambda function logs are available in CloudWatch Logs:

- `/aws/lambda/songbird-api-ingest` - Event ingestion from Notehub
- `/aws/lambda/songbird-api-devices` - Device CRUD operations
- `/aws/lambda/songbird-api-telemetry` - Telemetry queries
- `/aws/lambda/songbird-api-journeys` - Journeys and location history
- `/aws/lambda/songbird-api-commands` - Command operations
- `/aws/lambda/songbird-api-config` - Configuration management
- `/aws/lambda/songbird-api-alerts` - Alert management
- `/aws/lambda/songbird-api-activity` - Activity feed
- `/aws/lambda/songbird-api-settings` - User preferences
- `/aws/lambda/songbird-api-users` - User management (Admin)
- `/aws/lambda/songbird-api-notehub` - Notehub status

### DynamoDB Tables

The infrastructure creates the following DynamoDB tables:

| Table | Partition Key | Sort Key | Description |
|-------|--------------|----------|-------------|
| `songbird-devices` | `device_uid` | - | Device metadata and current state |
| `songbird-telemetry` | `device_uid` | `timestamp` | Temperature, humidity, pressure readings |
| `songbird-journeys` | `device_uid` | `journey_id` | Journey metadata (start/end time, distance, point count) |
| `songbird-locations` | `device_uid` | `timestamp` | All location events (GPS, Cell, Wi-Fi) |
| `songbird-commands` | `device_uid` | `timestamp` | Command history |
| `songbird-alerts` | `device_uid` | `created_at` | Alert history |

### DynamoDB Queries

Query telemetry data using the AWS CLI:

```bash
aws dynamodb query \
  --table-name songbird-telemetry \
  --key-condition-expression "device_uid = :uid AND #ts > :cutoff" \
  --expression-attribute-names '{"#ts": "timestamp"}' \
  --expression-attribute-values '{":uid": {"S": "dev:xxxxx"}, ":cutoff": {"N": "1700000000000"}}' \
  --scan-index-forward false \
  --limit 100
```

Query journeys for a device:

```bash
aws dynamodb query \
  --table-name songbird-journeys \
  --key-condition-expression "device_uid = :uid" \
  --expression-attribute-values '{":uid": {"S": "dev:xxxxx"}}' \
  --scan-index-forward false \
  --limit 10
```

## Cleanup

To remove all deployed resources:

```bash
cdk destroy
```

**Warning**: This will delete all data in DynamoDB tables.

## Troubleshooting

### Events Not Appearing

1. Check the Notehub route is correctly configured with the IngestUrl
2. Verify the route is enabled and not paused in Notehub
3. Test the route using Notehub's "Test Route" feature
4. Check CloudWatch Logs for the `songbird-api-ingest` Lambda
5. Look for any errors in the Lambda logs (DynamoDB permissions, malformed events, etc.)

### API Returns 401 Unauthorized

1. Verify the Cognito token is valid and not expired
2. Check the user exists in the Cognito User Pool
3. Ensure the Authorization header format: `Bearer <token>`

### Commands Not Reaching Device

1. Verify the Notehub API token is correctly set in Secrets Manager
2. Check the device is online in Notehub
3. Verify the `command.qi` Notefile is configured for inbound

## Cost Estimates

For a demo fleet of ~20 devices:

| Service | Estimated Monthly Cost |
|---------|----------------------|
| DynamoDB | $2-5 |
| Lambda | $1-2 |
| API Gateway | $2-4 |
| CloudFront | $1-2 |
| S3 | < $1 |
| Cognito | Free tier |
| **Total** | **~$8-14/month** |

Costs scale with data volume and API requests.

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

Copyright (c) 2025 Blues Inc.
