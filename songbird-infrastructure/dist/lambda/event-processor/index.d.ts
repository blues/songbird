/**
 * Event Processor Lambda
 *
 * Processes incoming Songbird events from IoT Core:
 * - Writes telemetry data to DynamoDB
 * - Updates device metadata in DynamoDB
 * - Triggers alerts via SNS for alert events
 */
interface SongbirdEvent {
    device_uid: string;
    serial_number?: string;
    fleet?: string;
    event_type: string;
    timestamp: number;
    received: number;
    body: {
        temp?: number;
        humidity?: number;
        pressure?: number;
        voltage?: number;
        motion?: boolean;
        mode?: string;
        type?: string;
        value?: number;
        threshold?: number;
        message?: string;
        cmd?: string;
        status?: string;
        executed_at?: number;
        milliamp_hours?: number;
        temperature?: number;
    };
    location?: {
        lat?: number;
        lon?: number;
        time?: number;
        source?: string;
    };
    tower?: {
        lat?: number;
        lon?: number;
    };
}
export declare const handler: (event: SongbirdEvent) => Promise<void>;
export {};
