# Songbird Cloud Infrastructure

AWS CDK infrastructure for the Songbird demo platform. This deploys all cloud resources needed to receive, store, and serve device telemetry data.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NOTEHUB                                        │
│                                  │                                          │
│                            Route (HTTPS)                                    │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              AWS CLOUD                                       │
│                                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐     │
│  │  IoT Core   │────▶│   Lambda    │────▶│  Timestream (telemetry)     │     │
│  │  (Rules)    │     │ (Processor) │     │  DynamoDB (device metadata) │     │
│  └─────────────┘     └──────┬──────┘     └─────────────────────────────┘     │
│                             │                         ▲                      │
│                             ▼                         │                      │
│                      ┌─────────────┐           ┌──────┴──────┐               │
│                      │     SNS     │           │   Lambda    │               │
│                      │  (Alerts)   │           │   (APIs)    │               │
│                      └─────────────┘           └──────┬──────┘               │
│                                                       │                      │
│  ┌─────────────┐     ┌─────────────┐           ┌──────┴──────┐               │
│  │  CloudFront │────▶│     S3      │           │ API Gateway │               │
│  │   (CDN)     │     │ (Dashboard) │           │  (HTTP API) │               │
│  └─────────────┘     └─────────────┘           └─────────────┘               │
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
│   ├── storage-construct.ts     # Timestream + DynamoDB
│   ├── auth-construct.ts        # Cognito User Pool
│   ├── iot-construct.ts         # IoT Core rules
│   ├── api-construct.ts         # API Gateway + Lambda
│   └── dashboard-construct.ts   # S3 + CloudFront
├── lambda/
│   ├── event-processor/         # Process incoming events
│   ├── alert-handler/           # Handle alert notifications
│   ├── api-devices/             # Devices API
│   ├── api-telemetry/           # Telemetry queries API
│   ├── api-commands/            # Commands API
│   └── api-config/              # Configuration API
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

Create a route in Notehub to send events to AWS IoT Core:

1. Go to your Notehub project → **Routes**
2. Create a new **AWS IoT Core** route
3. Configure:
   - **Region**: Same as your CDK deployment (e.g., `us-east-1`)
   - **Topic**: `songbird/events`
   - **Notefiles**: `track.qo`, `alert.qo`, `command_ack.qo`, `health.qo`, `_log.qo`
4. Use the JSONata transform from the PRD to format events

**Note**: The `_log.qo` Notefile contains Mojo power monitoring data (voltage, temperature, milliamp_hours) when enabled via the `_log` environment variable set to `power`.

### 3. Create Initial Cognito Users

Create admin users for the dashboard:

```bash
# Create a user
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId from CDK output> \
  --username admin@yourcompany.com \
  --user-attributes Name=email,Value=admin@yourcompany.com Name=name,Value="Admin User" \
  --temporary-password "TempPass123!"

# Add user to Admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> \
  --username admin@yourcompany.com \
  --group-name Admin
```

### 4. Note the Outputs

After deployment, CDK will output important values:

```
Outputs:
SongbirdStack.ApiUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com
SongbirdStack.DashboardUrl = https://xxxxxxxxxx.cloudfront.net
SongbirdStack.UserPoolId = us-east-1_xxxxxxxxx
SongbirdStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
SongbirdStack.IoTRuleName = songbird_event_processor
```

Save these for configuring the dashboard application.

## API Endpoints

Base URL: `https://<api-id>.execute-api.<region>.amazonaws.com`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/devices` | List all devices |
| GET | `/v1/devices/{device_uid}` | Get device details |
| PATCH | `/v1/devices/{device_uid}` | Update device metadata |
| GET | `/v1/devices/{device_uid}/telemetry` | Get telemetry history |
| GET | `/v1/devices/{device_uid}/location` | Get location history |
| GET | `/v1/devices/{device_uid}/power` | Get Mojo power monitoring history |
| GET | `/v1/devices/{device_uid}/commands` | Get command history |
| POST | `/v1/devices/{device_uid}/commands` | Send command to device |
| GET | `/v1/devices/{device_uid}/config` | Get device configuration |
| PUT | `/v1/devices/{device_uid}/config` | Update device configuration |
| PUT | `/v1/fleets/{fleet_uid}/config` | Update fleet configuration |

All endpoints require a valid Cognito JWT token in the `Authorization` header.

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

- `/aws/lambda/songbird-event-processor`
- `/aws/lambda/songbird-alert-handler`
- `/aws/lambda/songbird-api-devices`
- `/aws/lambda/songbird-api-telemetry`
- `/aws/lambda/songbird-api-commands`
- `/aws/lambda/songbird-api-config`

IoT Core errors are logged to:
- `/aws/iot/songbird-errors`

### Timestream Queries

Query telemetry data directly:

```sql
SELECT *
FROM "songbird"."telemetry"
WHERE device_uid = 'dev:xxxxx'
  AND time > ago(24h)
ORDER BY time DESC
LIMIT 100
```

## Cleanup

To remove all deployed resources:

```bash
cdk destroy
```

**Warning**: This will delete all data in Timestream and DynamoDB tables.

## Troubleshooting

### Events Not Appearing

1. Check the Notehub route is correctly configured
2. Verify IoT Core rule is active: AWS Console → IoT Core → Act → Rules
3. Check CloudWatch Logs for the event processor Lambda

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
| Timestream | $5-10 |
| DynamoDB | $1-2 |
| Lambda | $1-2 |
| API Gateway | $1-2 |
| IoT Core | $1-2 |
| CloudFront | $1-2 |
| S3 | < $1 |
| Cognito | Free tier |
| **Total** | **~$15-20/month** |

Costs scale with data volume and API requests.

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.
