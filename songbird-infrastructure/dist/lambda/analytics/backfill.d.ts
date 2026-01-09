/**
 * Aurora Analytics Backfill Lambda
 *
 * One-time backfill of existing DynamoDB data to Aurora analytics database.
 * Invoke manually to populate historical data.
 */
export declare const handler: (event: {
    tables?: string[];
}) => Promise<{
    statusCode: number;
    body: string;
}>;
