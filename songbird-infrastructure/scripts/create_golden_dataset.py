#!/usr/bin/env python3
"""
Create golden dataset from production traces in Phoenix.

Approach:
1. Scan DynamoDB chat history for successful queries (same source as daily evaluation)
2. Filter for quality and diversity
3. Upload as a Phoenix dataset for evaluation experiments

Usage:
    python3 scripts/create_golden_dataset.py
"""
import os
import sys
import json

try:
    import boto3
    from phoenix.client import Client
except ImportError as e:
    print(f"Error: Missing dependency - {e}")
    print("Install with: pip3 install arize-phoenix-client boto3")
    sys.exit(1)

PHOENIX_URL = os.environ.get("PHOENIX_URL", "https://phoenix.songbird.live")
CHAT_HISTORY_TABLE = os.environ.get("CHAT_HISTORY_TABLE", "songbird-chat-history")
DATASET_NAME = "analytics-golden-queries"
DATASET_DESCRIPTION = "Curated high-quality analytics queries for evaluation and testing"
TARGET_COUNT = 50


def scan_chat_history(table_name: str) -> list:
    """Scan DynamoDB chat history for queries with SQL and insights."""
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    table = dynamodb.Table(table_name)

    print(f"Scanning DynamoDB table '{table_name}'...")
    queries = []
    scan_kwargs = {}

    while True:
        response = table.scan(**scan_kwargs)
        items = response.get("Items", [])

        for item in items:
            sql = item.get("sql")
            question = item.get("question")
            insights = item.get("insights")

            # Only include queries with SQL and insights (presence implies success)
            if sql and question and insights:
                queries.append({
                    "question": question,
                    "sql": sql,
                    "insights": insights,
                    "timestamp": item.get("timestamp", 0),
                    "user_email": item.get("user_email", ""),
                    "session_id": item.get("session_id", ""),
                })

        # Paginate
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    return queries


def filter_golden(queries: list, target: int) -> list:
    """Filter for quality and deduplicate."""
    seen_questions = set()
    golden = []

    # Sort by timestamp descending (most recent first)
    queries.sort(key=lambda q: q["timestamp"], reverse=True)

    for q in queries:
        question = q["question"].strip()
        q_normalized = question.lower()

        # Skip duplicates
        if q_normalized in seen_questions:
            continue
        seen_questions.add(q_normalized)

        # Quality filters
        if len(question) < 15:
            continue
        if "error" in q["sql"].lower() and "select" not in q["sql"].lower():
            continue

        golden.append(q)
        if len(golden) >= target:
            break

    return golden


def main():
    # Step 1: Get queries from DynamoDB
    queries = scan_chat_history(CHAT_HISTORY_TABLE)
    print(f"Found {len(queries)} successful queries with SQL and insights")

    if len(queries) == 0:
        print("No queries found. Use the analytics chat in the dashboard first.")
        sys.exit(1)

    # Step 2: Filter for quality
    golden = filter_golden(queries, TARGET_COUNT)
    print(f"Filtered to {len(golden)} golden examples")

    if len(golden) == 0:
        print("No examples passed quality filters.")
        sys.exit(1)

    # Show samples
    print("\nSample examples:")
    for i in range(min(3, len(golden))):
        print(f"\n  [{i+1}] Question: {golden[i]['question'][:100]}")
        print(f"      SQL: {golden[i]['sql'][:100]}...")
        print(f"      Insights: {golden[i]['insights'][:100]}...")

    # Step 3: Create Phoenix dataset
    print(f"\nConnecting to Phoenix at {PHOENIX_URL}...")
    client = Client(base_url=PHOENIX_URL)

    inputs = [{"question": g["question"]} for g in golden]
    outputs = [{"sql": g["sql"], "insights": g["insights"]} for g in golden]
    metadata = [
        {
            "source": "dynamodb_chat_history",
            "user_email": g["user_email"],
            "session_id": g["session_id"],
            "timestamp": str(g["timestamp"]),
        }
        for g in golden
    ]

    print(f"Creating dataset '{DATASET_NAME}' with {len(golden)} examples...")
    try:
        dataset = client.datasets.create_dataset(
            name=DATASET_NAME,
            dataset_description=DATASET_DESCRIPTION,
            inputs=inputs,
            outputs=outputs,
            metadata=metadata,
        )
        print(f"\nDataset created successfully!")
    except (KeyError, Exception) as e:
        # Phoenix 8.0 returns null body on success, which causes the client to error.
        # The upload still succeeds - verify via GraphQL.
        import httpx
        resp = httpx.post(
            f"{PHOENIX_URL}/graphql",
            json={"query": '{ datasets { edges { node { name exampleCount } } } }'},
            timeout=15,
        )
        data = resp.json().get("data", {})
        datasets = data.get("datasets", {}).get("edges", [])
        match = [d for d in datasets if d["node"]["name"] == DATASET_NAME]
        if match:
            count = match[0]["node"]["exampleCount"]
            print(f"\nDataset created successfully! ({count} examples)")
        else:
            print(f"\nWarning: Upload may have failed - {e}")
            sys.exit(1)

    print(f"View in Phoenix UI: {PHOENIX_URL}")
    print(f"Navigate to: Datasets > {DATASET_NAME}")


if __name__ == "__main__":
    main()
