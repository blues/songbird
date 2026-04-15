# Security and Data Access

Security invariants for the Songbird backend Lambda layer — parameterized SQL, authorization checks, and device-scoped data access.

## Parameterized SQL Queries

All Aurora queries use RDS Data API `parameters` — never string interpolation or manual quote-escaping. This applies to every `ExecuteStatementCommand` call across the analytics layer.

The two Lambda functions that write to `analytics.rag_documents` must follow this rule:

- [[songbird-infrastructure/lambda/shared/rag-retrieval.ts#retrieveRelevantContext]] — vector similarity search passes the embedding and title exclusion list as named parameters (`:embedding`, `:limit`, `:p0`…`:pN`).
- [[songbird-infrastructure/lambda/analytics/feedback.ts#indexPositiveFeedback]] — DELETE and INSERT for the upsert pattern use `:title`, `:content`, `:embedding`, `:metadata` parameters.

String values that were previously escaped with `.replace(/'/g, "''")` must not return. Parameterized queries eliminate that class of bug entirely.

## Admin Authorization on Feedback Endpoint

The `GET /analytics/feedback` route returns all users' query history (questions, generated SQL, usernames). It must verify the caller belongs to the Cognito `Admin` group before returning any data.

The check reads `cognito:groups` from the JWT claims injected by API Gateway's JWT authorizer. A missing or non-Admin group claim returns 403. This is a defense-in-depth check — the endpoint may also be restricted at the API Gateway level, but the Lambda must not rely solely on that.

See [[songbird-infrastructure/lambda/analytics/feedback.ts#handler]].

## Device Serial Number Authorization

Chat query requests must supply an explicit `deviceSerialNumbers` array. If the array is absent or empty, the handler returns 403 immediately.

The previous behavior — falling back to `SELECT DISTINCT serial_number FROM analytics.devices` — granted unrestricted data access to any caller who omitted the field. That fallback has been removed.

See [[songbird-infrastructure/lambda/analytics/chat-query.ts#handler]].

## Integer Query Parameter Safety

Query-string parameters that feed into DynamoDB `Limit` values must be parsed with [[songbird-infrastructure/lambda/shared/utils.ts#parseIntParam]], not bare `parseInt()`. Bare `parseInt()` returns `NaN` for non-numeric input, which propagates into DynamoDB and causes 500 errors with no useful message.

`parseIntParam` returns the default when the value is missing, non-numeric, or less than 1, and optionally clamps the result to a maximum. All five GET-list handlers (`api-devices`, `api-alerts`, `api-telemetry`, `api-activity`, `api-journeys`) use this helper.

## JSON Body Error Handling in Mutation Paths

POST/PATCH/DELETE handlers that call `JSON.parse(event.body)` must wrap the call in a try/catch that returns a 400 with a descriptive error. Uncaught `SyntaxError` from malformed JSON propagates to the outer catch and becomes an opaque 500.

Handlers that apply this guard:
- [[songbird-infrastructure/lambda/api-devices/index.ts#mergeDevices]] — `POST /devices/merge`
- [[songbird-infrastructure/lambda/api-devices/index.ts#updateDeviceBySerial]] — `PATCH /devices/{serial_number}`
- [[songbird-infrastructure/lambda/api-commands/index.ts#sendCommand]] — `POST /devices/{serial_number}/commands`
