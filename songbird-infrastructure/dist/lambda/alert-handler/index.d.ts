/**
 * Alert Handler Lambda
 *
 * Specialized handler for alert events.
 * Sends notifications and updates device status.
 */
interface AlertEvent {
    device_uid: string;
    serial_number?: string;
    fleet?: string;
    event_type: string;
    timestamp: number;
    body: {
        type: string;
        value: number;
        threshold: number;
        message?: string;
    };
    location?: {
        lat?: number;
        lon?: number;
    };
}
export declare const handler: (event: AlertEvent) => Promise<void>;
export {};
