/**
 * Global test setup for Songbird Infrastructure tests
 * Sets environment variables used by Lambda handlers
 */

process.env.TELEMETRY_TABLE = 'test-telemetry';
process.env.DEVICES_TABLE = 'test-devices';
process.env.ALERTS_TABLE = 'test-alerts';
process.env.COMMANDS_TABLE = 'test-commands';
process.env.JOURNEYS_TABLE = 'test-journeys';
process.env.LOCATIONS_TABLE = 'test-locations';
process.env.DEVICE_ALIASES_TABLE = 'test-device-aliases';
process.env.ACTIVITY_TABLE = 'test-activity';
process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-alerts';
process.env.NOTEHUB_PROJECT_UID = 'app:test-project';
process.env.NOTEHUB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789:secret:test-notehub';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.DASHBOARD_URL = 'https://test.songbird.live';
process.env.AUDIT_TABLE = 'test-audit';
process.env.CHAT_HISTORY_TABLE = 'test-chat-history';
process.env.CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789:cluster:test-cluster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789:secret:test-secret';
process.env.DATABASE_NAME = 'test-analytics';
process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';
process.env.REPORT_SNS_TOPIC = 'arn:aws:sns:us-east-1:123456789:test-eval-reports';
process.env.SEED_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789:function:test-seed';
