---
planStatus:
  planId: plan-phoenix-implementation
  title: Phoenix Implementation Guide - Using Phoenix to Improve Analytics
  status: complete
  planType: feature
  priority: high
  owner: satch
  stakeholders: []
  tags:
    - observability
    - analytics
    - llm
    - phoenix
    - prompts
  created: "2026-02-19"
  updated: "2026-02-20T00:00:00.000Z"
  progress: 100
---
# Using Phoenix to Improve Songbird Analytics

This guide explains how to use Phoenix's features to monitor, iterate on, and improve the Songbird Analytics text-to-SQL feature.

**Phoenix UI**: https://phoenix.songbird.live

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Viewing Traces](#viewing-traces)
3. [Using the Prompt Hub](#using-the-prompt-hub)
4. [Testing Prompts in the Playground](#testing-prompts-in-the-playground)
5. [Switching Models](#switching-models)
6. [Iterating on Prompts](#iterating-on-prompts)
7. [Monitoring Query Quality](#monitoring-query-quality)
8. [Creating a Golden Dataset](#creating-a-golden-dataset)
9. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
User asks question in Dashboard
         |
         v
+-----------------------------------------+
|  chat-query Lambda                      |
|                                         |
|  1. Fetch prompt from Phoenix Prompt Hub|
|  2. Render template with user question  |
|  3. Call Bedrock (Claude) to generate SQL|
|  4. Validate & execute SQL on Aurora    |
|  5. Call Bedrock to generate insights   |
|  6. Send OTLP traces to Phoenix        |
|  7. Return response to dashboard       |
+-----------------------------------------+
         |
         v
+-----------------------------------------+
|  Phoenix (v13.0.3 on ECS Fargate)       |
|                                         |
|  - Traces: Full request lifecycle       |
|  - Prompts: Versioned prompt management |
|  - Playground: Test prompts with Anthropic|
|  - Datasets: Curated test queries       |
+-----------------------------------------+
```

### Key Integration Points

| Component | Description |
| --- | --- |
| **OTLP Traces** | Lambda sends traces via HTTPS to `https://phoenix.songbird.live/v1/traces` |
| **Prompt Hub** | Lambda fetches prompts from Phoenix REST API with 5-min cache |
| **Model Mapping** | Phoenix stores Anthropic API model IDs; Lambda maps them to Bedrock equivalents |
| **Fallback** | If Phoenix is unreachable, Lambda uses hardcoded fallback prompts |

### Prompts in Phoenix

Two prompts are managed in Phoenix:

| Prompt Name | Purpose | Fallback Model |
| --- | --- | --- |
| `songbird-sql-generator` | Converts natural language questions to PostgreSQL queries | Claude Sonnet 4.5 |
| `songbird-insights-generator` | Generates concise data insights from query results | Claude Sonnet 4.5 |

---

## Viewing Traces

Every analytics query creates a trace in Phoenix with the following span hierarchy:

```
chat_query (CHAIN)
+-- bedrock.generate_sql (LLM)
|   +-- Input prompt, output SQL, token usage, model ID
+-- validate_sql (TOOL)
|   +-- SQL validation result (pass/fail)
+-- execute_sql (TOOL)
|   +-- SQL executed, row count, any errors
+-- bedrock.generate_insights (LLM)
    +-- Input data preview, output insights, token usage
```

### How to View Traces

1. Go to **https://phoenix.songbird.live**
2. Click **Traces** in the left sidebar
3. Filter by project: **Songbird**
4. Click any trace to see the full span hierarchy
5. Click a span to see its attributes (prompt text, SQL output, token counts, etc.)

### Useful Filters

- **Failed queries**: Filter by `status = ERROR`
- **Slow queries**: Sort by duration descending
- **Specific user question**: Search in span attributes for the question text
- **By model**: Filter by `llm.request.model` attribute

### What to Look For

- **SQL generation quality**: Check `bedrock.generate_sql` span output for valid SQL
- **Execution failures**: Check `execute_sql` span for errors (bad SQL, timeout, etc.)
- **Token usage**: Check `llm.usage.input_tokens` and `llm.usage.output_tokens` on LLM spans
- **Latency breakdown**: See how much time is spent in each step

---

## Using the Prompt Hub

The Prompt Hub lets you edit prompts **without redeploying Lambda code**. Changes are picked up within 5 minutes (the cache TTL).

### Viewing Prompts

1. Go to **Prompts** in the left sidebar
2. You'll see `songbird-sql-generator` and `songbird-insights-generator`
3. Click a prompt to see its template and version history

### How Prompts Work

Each prompt has:
- **Template**: The prompt text with `{{ variables }}` (mustache-style)
- **Model**: The Anthropic API model ID (e.g., `claude-sonnet-4-5-20250929`)
- **Invocation Parameters**: `temperature`, `max_tokens`, etc.
- **Versions**: Every edit creates a new version
- **Tags**: The `production` tag marks the active version

### Template Variables

**SQL Generator** (`songbird-sql-generator`):
- `{{ question }}` - The user's natural language question

**Insights Generator** (`songbird-insights-generator`):
- `{{ question }}` - The original user question
- `{{ sql }}` - The generated SQL query
- `{{ data_preview }}` - First 10 rows of results (JSON)
- `{{ data_count }}` - Total number of result rows

### Editing a Prompt

1. Click on the prompt name
2. Edit the template text directly
3. Adjust model settings if needed (model, temperature, max_tokens)
4. Click **Save** to create a new version
5. The Lambda will pick up the new version within 5 minutes

> **Tip**: Test changes in the Playground before saving to production. See [Testing Prompts in the Playground](#testing-prompts-in-the-playground).

---

## Testing Prompts in the Playground

The Playground lets you run prompts against the Anthropic API directly from the Phoenix UI, using your Anthropic API key.

### Setup (One-Time)

1. Go to **Settings** (gear icon)
2. Under **API Keys**, add your Anthropic API key
3. This key is only used for Playground testing -- the Lambda uses AWS Bedrock

### Running a Prompt

1. Go to **Prompts** -> click a prompt
2. Click **Playground** tab
3. Fill in the template variables (e.g., `question = "Show me device temperatures"`)
4. Click **Run**
5. See the model's response, token usage, and latency

### What to Test

- **Different questions**: Try simple, medium, and complex queries
- **Edge cases**: Ambiguous questions, questions about data that doesn't exist
- **Temperature changes**: Try 0.0 (deterministic) vs 0.3 (slightly creative)
- **Model changes**: Compare Claude Sonnet 4.5 vs Haiku 4.5 for speed/cost tradeoffs

### Important Notes

- The Playground calls the **Anthropic API directly**, not Bedrock
- Model IDs must be in Anthropic API format (e.g., `claude-sonnet-4-5-20250929`)
- The Lambda automatically maps these to Bedrock equivalents when fetching the prompt
- Only set **one of** `temperature` or `top_p` (Claude 4.x doesn't allow both)

---

## Switching Models

You can change which Claude model the analytics feature uses by editing the prompt in Phoenix -- no Lambda redeployment needed.

### Available Models

| Anthropic API ID | Bedrock ID | Best For |
| --- | --- | --- |
| `claude-sonnet-4-5-20250929` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Best quality, recommended |
| `claude-haiku-4-5-20251001` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Faster, cheaper |
| `claude-3-5-sonnet-20241022` | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | Legacy, still works |
| `claude-3-5-haiku-20241022` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Legacy, fastest |

### How to Switch

1. Go to **Prompts** -> click the prompt
2. Change the **Model** field to the desired Anthropic API model ID
3. Save the new version
4. The Lambda picks up the change within 5 minutes and maps it to the Bedrock equivalent

### First-Time Model Activation

When using a new Anthropic model for the first time in your AWS account:
- The Lambda's IAM role has `aws-marketplace:Subscribe` permissions
- First invocation triggers automatic Marketplace subscription
- May take ~2 minutes to activate
- Subsequent calls work normally

### Cost Considerations

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Typical Query Cost |
| --- | --- | --- | --- |
| Sonnet 4.5 | $3.00 | $15.00 | ~$0.03-0.05 |
| Haiku 4.5 | $1.00 | $5.00 | ~$0.01-0.02 |

**Strategy**: Use Sonnet 4.5 for SQL generation (needs precision) and consider Haiku 4.5 for insights generation (more forgiving).

---

## Iterating on Prompts

### Workflow for Improving Query Quality

1. **Identify Issues in Traces**
   - Look for failed queries (ERROR status)
   - Check SQL that executed but returned wrong results
   - Find insights that are generic or unhelpful

2. **Understand the Pattern**
   - What types of questions are failing?
   - Is the SQL structurally wrong or just missing context?
   - Are certain table joins or filters being missed?

3. **Edit the Prompt**
   - Add more examples (few-shot) for the failing pattern
   - Clarify schema details the model is getting wrong
   - Add explicit instructions for edge cases

4. **Test in Playground**
   - Use the failing question as test input
   - Verify the new prompt produces correct SQL
   - Test 5-10 other questions to check for regressions

5. **Deploy**
   - Save the new prompt version in Phoenix
   - The Lambda picks it up within 5 minutes
   - Monitor traces for the next few queries to verify

### Common Prompt Improvements

**Problem**: Model generates SQL for tables that don't exist
**Fix**: Add explicit schema definition at the top of the prompt with table names and column types

**Problem**: Model forgets the device filter
**Fix**: Add an instruction like "You MUST include `WHERE serial_number IN (:deviceFilter)` in every query"

**Problem**: Queries return too many rows
**Fix**: Add "Always include a `LIMIT 1000` clause"

**Problem**: Insights are too generic
**Fix**: Add examples of good insights that reference specific data values and patterns

**Problem**: Wrong visualization type selected
**Fix**: Add clearer rules like "Use `line_chart` for time-series data, `bar_chart` for comparisons, `table` for detailed records"

### Version History

Every prompt edit creates a new version. You can:
- View the diff between versions
- Roll back to a previous version by re-saving it
- Tag a version as `production` to make it active

---

## Monitoring Query Quality

### Daily Evaluation Lambda

A scheduled Lambda runs at **8am UTC daily** and evaluates the last 24 hours of queries:

- **SQL Syntax Validation**: Checks for dangerous keywords, missing filters, balanced parentheses
- **Execution Success Rate**: Tracks how many queries execute without errors
- **Query Complexity Distribution**: Categorizes queries as simple/medium/complex
- **LLM-as-Judge Evaluators**: Uses Claude to evaluate insight relevance and SQL hallucination

### CloudWatch Dashboard

View metrics at: [Songbird-Analytics Dashboard](https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=Songbird-Analytics)

Key metrics:
- Syntax valid rate (target: >95%)
- Execution success rate (target: >90%)
- Insight relevance score (1-5 scale, target: >3.5)
- SQL hallucination score (target: <0.2)
- Lambda duration (p50, p99)

### Tracing-Based Monitoring

In Phoenix, you can also:
- Sort traces by duration to find slow queries
- Filter for ERROR status to find failures
- Look at token usage trends to monitor costs
- Compare output quality across different prompt versions

---

## Creating a Golden Dataset

A golden dataset is a curated set of high-quality query examples used for evaluation and regression testing.

### Manual Curation in Phoenix UI

1. Go to **Traces** -> filter for successful queries (`status = OK`)
2. Review traces to find good examples that cover:
   - Simple queries (single table, basic aggregation)
   - Medium queries (JOINs, GROUP BY, time filters)
   - Complex queries (CTEs, window functions, subqueries)
   - All data types (temperature, location, alerts, journeys, devices)
3. Select ~50 traces
4. Create a **Dataset** from the selected traces
5. Name: `analytics-golden-queries`
6. Annotate each example with:
   - **Query Type**: location / temperature / alerts / journey / general
   - **Complexity**: simple / medium / complex
   - **Expected Visualization**: line_chart / bar_chart / table / scatter

### Using the Dataset

Once curated, you can:
- Run new prompt versions against the golden dataset to check for regressions
- Compare output quality across model changes
- Track improvement over time

---

## Troubleshooting

### Traces Not Appearing

**Check Lambda logs**:
```bash
aws logs tail /aws/lambda/songbird-analytics-chat-query --follow
```

Look for:
- `OpenTelemetry initialized` -- confirms tracing is set up
- `Flushing spans to Phoenix...` -- confirms export is attempted
- `Spans flushed successfully` -- confirms traces were sent
- `Error flushing spans: OTLPExporterError: Request Timeout` -- network/endpoint issue

**Check that the prompt is being fetched**:
```
Fetched prompt "songbird-sql-generator" from Phoenix (model: claude-sonnet-4-5-20250929)
```

**Check Phoenix health**:
```bash
curl https://phoenix.songbird.live/healthz
```

**Common causes**:
- Phoenix container restarted (check ECS service events)
- ALB target group unhealthy (check target health in AWS Console)
- Lambda security group doesn't allow egress to ALB on port 443

### Prompts Not Updating

The Lambda caches prompts for **5 minutes**. After editing a prompt in Phoenix:
1. Wait 5 minutes, OR
2. The next Lambda cold start will fetch the latest

If you see `using fallback` in the logs, Phoenix is unreachable from the Lambda.

### Model Access Denied

```
AccessDeniedException: Model access is denied due to IAM user or service role
is not authorized to perform the required AWS Marketplace actions
```

The Lambda role needs `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe` permissions for first-time model invocation. This is already configured in CDK but may need redeployment.

### Phoenix UI Not Loading

1. Check ECS service status:
```bash
aws ecs describe-services --cluster songbird-phoenix --services phoenix --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
```

2. Check ALB target health:
```bash
aws elbv2 describe-target-health --target-group-arn <tg-arn>
```

3. Check container logs:
```bash
aws ecs execute-command --cluster songbird-phoenix --task <task-id> --container phoenix --interactive --command "/bin/sh"
```

---

## Seeding Prompts

If Phoenix data is lost (container restart with empty EFS, or fresh deployment), re-seed the prompts:

```bash
cd songbird-infrastructure
PHOENIX_HOST=https://phoenix.songbird.live npx tsx scripts/seed-phoenix-prompts.ts
```

This creates both prompts with:
- Tagged as `production`
- Model: `claude-sonnet-4-5-20250929`
- Temperature: 0.0 (SQL) / 0.5 (insights)
- Max tokens: 4096 (SQL) / 500 (insights)

---

## Key Files Reference

| File | Purpose |
| --- | --- |
| `lambda/shared/phoenix-prompts.ts` | Prompt fetching, caching, model ID mapping |
| `lambda/shared/tracing.ts` | OTLP trace initialization and flush |
| `lambda/analytics/chat-query.ts` | Main analytics handler with prompt + trace integration |
| `lambda/analytics/evaluators.ts` | SQL validation and LLM-based evaluators |
| `lambda/analytics/daily-evaluation.ts` | Scheduled evaluation Lambda |
| `scripts/seed-phoenix-prompts.ts` | One-time prompt seeding script |
| `lib/observability-construct.ts` | Phoenix ECS Fargate + ALB infrastructure |
| `lib/analytics-construct.ts` | Lambda definitions, CloudWatch dashboard |

---

## Resources

- [Phoenix Documentation](https://arize.com/docs/phoenix)
- [Phoenix Self-Hosting Configuration](https://arize.com/docs/phoenix/self-hosting/configuration)
- [Phoenix Release Notes](https://arize.com/docs/phoenix/release-notes)
- [OpenTelemetry Tracing Guide](https://opentelemetry.io/docs/concepts/observability-primer/#distributed-traces)
- [Phoenix UI](https://phoenix.songbird.live)
- [CloudWatch Dashboard: Songbird-Analytics](https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=Songbird-Analytics)
