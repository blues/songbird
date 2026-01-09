# Analytics Feature - Integration Checklist

## ✅ Files Already Created

All analytics files have been created and are ready to use:

### Backend (Infrastructure)
- ✅ `songbird-infrastructure/lib/analytics-construct.ts`
- ✅ `songbird-infrastructure/lambda/analytics/init-schema.ts`
- ✅ `songbird-infrastructure/lambda/analytics/sync-to-aurora.ts`
- ✅ `songbird-infrastructure/lambda/analytics/chat-query.ts`
- ✅ `songbird-infrastructure/lambda/analytics/chat-history.ts`

### Frontend (Dashboard)
- ✅ `songbird-dashboard/src/pages/Analytics.tsx`
- ✅ `songbird-dashboard/src/components/analytics/ChatMessage.tsx`
- ✅ `songbird-dashboard/src/components/analytics/QueryVisualization.tsx`
- ✅ `songbird-dashboard/src/components/analytics/SuggestedQuestions.tsx`
- ✅ `songbird-dashboard/src/components/analytics/index.ts`
- ✅ `songbird-dashboard/src/hooks/useAnalytics.ts`
- ✅ `songbird-dashboard/src/api/analytics.ts`
- ✅ `songbird-dashboard/src/types/analytics.ts`

### Frontend (Modified)
- ✅ `songbird-dashboard/src/App.tsx` - Added Analytics route
- ✅ `songbird-dashboard/src/components/layout/Sidebar.tsx` - Added Analytics nav link

### Documentation
- ✅ `ANALYTICS_DEPLOYMENT.md`
- ✅ `ANALYTICS_IMPLEMENTATION_SUMMARY.md`
- ✅ `ANALYTICS_INTEGRATION_CHECKLIST.md` (this file)

## 🔧 Required Integration Steps

### Step 1: Enable DynamoDB Streams

Update `songbird-infrastructure/lib/storage-construct.ts`:

```typescript
// For each table that needs to sync (Devices, Telemetry, Locations, Alerts, Journeys, Power)
// Add stream configuration:

const devicesTable = new dynamodb.Table(this, 'DevicesTable', {
  // ... existing config ...
  stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,  // ADD THIS LINE
});

// Repeat for:
// - telemetryTable
// - locationsTable
// - alertsTable
// - journeysTable
// - powerTable (if it exists)
```

### Step 2: Update Main Stack

Update `songbird-infrastructure/lib/songbird-stack.ts`:

```typescript
// 1. Add import at top
import { AnalyticsConstruct } from './analytics-construct';

// 2. After creating storage and other constructs, add:
const analytics = new AnalyticsConstruct(this, 'Analytics', {
  devicesTable: storage.devicesTable,
  telemetryTable: storage.telemetryTable,
  locationsTable: storage.locationsTable,
  alertsTable: storage.alertsTable,
  journeysTable: storage.journeysTable,
  powerTable: storage.powerTable,  // If you have this table
});

// 3. Add analytics endpoints to API
// See next step for API integration
```

### Step 3: Add API Routes

Update `songbird-infrastructure/lib/api-construct.ts`:

```typescript
// Add this method to ApiConstruct class:

public addAnalyticsRoutes(
  chatQueryLambda: lambda.Function,
  chatHistoryLambda: lambda.Function
) {
  const chatQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
    'ChatQueryIntegration',
    chatQueryLambda
  );

  const chatHistoryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
    'ChatHistoryIntegration',
    chatHistoryLambda
  );

  // POST /analytics/chat
  this.api.addRoutes({
    path: '/analytics/chat',
    methods: [apigateway.HttpMethod.POST],
    integration: chatQueryIntegration,
    authorizer: this.authorizer,
  });

  // GET /analytics/history
  this.api.addRoutes({
    path: '/analytics/history',
    methods: [apigateway.HttpMethod.GET],
    integration: chatHistoryIntegration,
    authorizer: this.authorizer,
  });
}
```

Then call it from your stack:

```typescript
// In songbird-stack.ts after creating analytics construct:
api.addAnalyticsRoutes(analytics.chatQueryLambda, analytics.chatHistoryLambda);
```

### Step 4: Export Lambda Functions

Update `songbird-infrastructure/lib/analytics-construct.ts`:

Add exports at the end of the class:

```typescript
export class AnalyticsConstruct extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly chatHistoryTable: dynamodb.Table;
  public readonly chatQueryLambda: lambda.Function;      // ADD THIS
  public readonly chatHistoryLambda: lambda.Function;    // ADD THIS

  constructor(scope: Construct, id: string, props: AnalyticsConstructProps) {
    super(scope, id);

    // ... existing code ...

    // At the end, assign to public properties:
    this.chatQueryLambda = chatQueryLambda;
    this.chatHistoryLambda = chatHistoryLambda;
  }
}
```

### Step 5: Enable AWS Bedrock

**Before deploying**, enable Bedrock in your AWS account:

1. Go to AWS Console → Bedrock (us-east-1 region)
2. Click "Model access" in left sidebar
3. Click "Enable specific models"
4. Check "Anthropic Claude 3.5 Sonnet v2"
5. Click "Save changes"
6. Wait for "Access granted" status (usually instant)

### Step 6: Deploy Infrastructure

```bash
cd songbird-infrastructure

# Install dependencies (if new packages needed)
npm install

# Check for any TypeScript errors
npm run build

# Synthesize to preview changes
npx cdk synth

# Deploy all stacks
npx cdk deploy --all

# Note the output:
# - ClusterEndpoint
# - SecretArn
# - ChatHistoryTable name
```

### Step 7: Initialize Database Schema

After successful deployment:

```bash
# Find the init Lambda function name
aws lambda list-functions --query "Functions[?contains(FunctionName, 'InitSchema')].FunctionName" --output table

# Invoke it
aws lambda invoke \
  --function-name YOUR_INIT_SCHEMA_FUNCTION_NAME \
  --region us-east-1 \
  response.json

# Check response
cat response.json
```

### Step 8: Deploy Dashboard

```bash
cd songbird-dashboard

# Install any new dependencies
npm install

# Build
npm run build

# Test locally (optional)
npm run preview

# Deploy (your existing deployment method)
# For example, if using S3:
aws s3 sync dist/ s3://YOUR_BUCKET/
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/*"
```

### Step 9: Verify Integration

1. **Check Streams**: Verify DynamoDB streams are enabled
   ```bash
   aws dynamodb describe-table --table-name Devices \
     --query 'Table.StreamSpecification'
   ```

2. **Check API**: Test chat endpoint
   ```bash
   curl -X POST https://YOUR_API_URL/analytics/chat \
     -H "Authorization: Bearer YOUR_COGNITO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"question":"Show me all devices","sessionId":"test","userEmail":"your@email.com"}'
   ```

3. **Check Frontend**: Navigate to `/analytics` in dashboard

## 🎯 Quick Test Checklist

Once deployed, verify these work:

- [ ] Navigate to `/analytics` page loads
- [ ] Suggested questions appear
- [ ] Click a suggested question populates input
- [ ] Ask "Show me all devices" and get response
- [ ] SQL query is displayed correctly
- [ ] Visualization renders (table/chart)
- [ ] Insights text is readable
- [ ] Chat history persists on page reload
- [ ] Can ask follow-up questions
- [ ] Stats cards show query count

## 🐛 Common Issues & Fixes

### Issue: "Bedrock Access Denied"
**Fix**: Enable Claude 3.5 Sonnet in Bedrock console (Step 5)

### Issue: "Table does not exist"
**Fix**: Run init-schema Lambda (Step 7)

### Issue: "No data syncing to Aurora"
**Fix**: Check DynamoDB streams are enabled (Step 1)

### Issue: "API 404 on /analytics/chat"
**Fix**: Verify API routes were added (Step 3) and deployed

### Issue: "Frontend shows 'Failed to load analytics'"
**Fix**: Check API URL in `config.json` matches deployed API Gateway URL

### Issue: "Empty results in queries"
**Fix**: Check user has devices assigned in Cognito or devices exist in Aurora

## 📊 Post-Deployment Monitoring

Set up CloudWatch alarms for:

```bash
# Bedrock throttling
aws cloudwatch put-metric-alarm \
  --alarm-name bedrock-throttled \
  --metric-name ThrottledRequests \
  --namespace AWS/Bedrock \
  --threshold 10 \
  --evaluation-periods 1

# Aurora high CPU
aws cloudwatch put-metric-alarm \
  --alarm-name aurora-high-cpu \
  --metric-name CPUUtilization \
  --namespace AWS/RDS \
  --threshold 80 \
  --evaluation-periods 2

# Lambda errors
aws cloudwatch put-metric-alarm \
  --alarm-name chat-lambda-errors \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --dimensions Name=FunctionName,Value=ChatQueryLambda \
  --threshold 5 \
  --evaluation-periods 1
```

## 🔄 Rollback Plan

If issues arise, rollback steps:

```bash
# 1. Remove analytics route from frontend
# Comment out in App.tsx and Sidebar.tsx

# 2. Redeploy dashboard
cd songbird-dashboard && npm run build && # deploy

# 3. Remove backend infrastructure
cd songbird-infrastructure
npx cdk destroy AnalyticsStack
# OR
# Comment out analytics construct in songbird-stack.ts and redeploy

# 4. Disable DynamoDB streams (optional)
# Remove stream config from storage-construct.ts and redeploy
```

## ✅ Success Criteria

You'll know the integration is successful when:

1. ✅ Infrastructure deploys without errors
2. ✅ Init schema Lambda runs successfully
3. ✅ Data starts syncing to Aurora (check with SQL query)
4. ✅ Analytics page loads in dashboard
5. ✅ Can ask questions and get responses
6. ✅ Visualizations render correctly
7. ✅ Chat history persists
8. ✅ No errors in CloudWatch Logs

## 📞 Support

If you encounter issues:

1. Check CloudWatch Logs for Lambda functions
2. Review Aurora query logs
3. Test API endpoints with curl
4. Verify Bedrock model access
5. Check IAM permissions for Lambda roles

---

**Ready to integrate?** Follow the steps above in order. Estimated time: 30-60 minutes.
