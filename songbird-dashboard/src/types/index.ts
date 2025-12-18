/**
 * Songbird Dashboard Type Definitions
 */

// Operating modes for devices
export type OperatingMode = 'demo' | 'transit' | 'storage' | 'sleep';

// Motion sensitivity levels
export type MotionSensitivity = 'low' | 'medium' | 'high';

// Device status
export type DeviceStatus = 'online' | 'offline' | 'unknown';

// Alert types
export type AlertType =
  | 'temp_high'
  | 'temp_low'
  | 'humidity_high'
  | 'humidity_low'
  | 'pressure_change'
  | 'low_battery'
  | 'motion';

// Command types
export type CommandType = 'ping' | 'locate' | 'play_melody' | 'test_audio' | 'set_volume';

// Command status
export type CommandStatus = 'queued' | 'sent' | 'ok' | 'error' | 'ignored';

/**
 * Device interface
 */
export interface Device {
  device_uid: string;
  serial_number: string;
  name?: string;
  fleet_uid?: string;
  fleet_name?: string;
  assigned_to?: string;
  status: DeviceStatus;
  last_seen?: string;
  mode: OperatingMode;
  firmware_version?: string;
  notecard_version?: string;
  // Latest telemetry
  temperature?: number;
  humidity?: number;
  pressure?: number;
  voltage?: number;
  // Latest location
  latitude?: number;
  longitude?: number;
  location_time?: string;
  // Configuration
  audio_enabled?: boolean;
  audio_volume?: number;
  led_enabled?: boolean;
  // Metadata
  created_at: string;
  updated_at: string;
}

/**
 * Telemetry data point
 */
export interface TelemetryPoint {
  time: string;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  voltage?: number;
  motion?: boolean;
}

/**
 * Location data point
 */
export interface LocationPoint {
  time: string;
  lat: number;
  lon: number;
}

/**
 * Mojo power monitoring data point
 */
export interface PowerPoint {
  time: string;
  voltage?: number;
  temperature?: number;
  milliamp_hours?: number;
}

/**
 * Health event data point (_health.qo)
 */
export interface HealthPoint {
  time: string;
  method?: string;
  text?: string;
  voltage?: number;
  voltage_mode?: string;
  milliamp_hours?: number;
}

/**
 * Alert record
 */
export interface Alert {
  alert_id: string;
  device_uid: string;
  serial_number?: string;
  fleet?: string;
  type: AlertType;
  value?: number;
  threshold?: number;
  message: string;
  created_at: number; // Timestamp in milliseconds
  event_timestamp?: number;
  acknowledged: string | boolean; // 'true' or 'false' (string for GSI)
  acknowledged_at?: number;
  acknowledged_by?: string;
  location?: {
    lat?: number;
    lon?: number;
  };
}

/**
 * Command record
 */
export interface Command {
  command_id: string;
  device_uid: string;
  cmd: CommandType;
  params?: Record<string, unknown>;
  status: CommandStatus;
  created_at: string;
  sent_at?: string;
  acknowledged_at?: string;
  ack_status?: 'ok' | 'error' | 'ignored';
  ack_message?: string;
}

/**
 * Device configuration
 */
export interface DeviceConfig {
  mode: OperatingMode;
  gps_interval_min: number;
  sync_interval_min: number;
  heartbeat_hours: number;
  temp_alert_high_c: number;
  temp_alert_low_c: number;
  humidity_alert_high: number;
  humidity_alert_low: number;
  pressure_alert_delta: number;
  voltage_alert_low: number;
  motion_sensitivity: MotionSensitivity;
  motion_wake_enabled: boolean;
  audio_enabled: boolean;
  audio_volume: number;
  audio_alerts_only: boolean;
  cmd_wake_enabled: boolean;
  cmd_ack_enabled: boolean;
  locate_duration_sec: number;
  led_enabled: boolean;
  debug_mode: boolean;
}

/**
 * Fleet summary
 */
export interface Fleet {
  fleet_uid: string;
  name: string;
  device_count: number;
  online_count: number;
  offline_count: number;
  alert_count: number;
}

/**
 * Dashboard summary statistics
 */
export interface DashboardStats {
  total_devices: number;
  online_devices: number;
  offline_devices: number;
  active_alerts: number;
  low_battery_count: number;
}

/**
 * API Response types
 */
export interface DevicesResponse {
  devices: Device[];
  total: number;
}

export interface TelemetryResponse {
  device_uid: string;
  hours: number;
  count: number;
  telemetry: TelemetryPoint[];
}

export interface LocationResponse {
  device_uid: string;
  hours: number;
  count: number;
  locations: LocationPoint[];
}

export interface PowerResponse {
  device_uid: string;
  hours: number;
  count: number;
  power: PowerPoint[];
}

export interface HealthResponse {
  device_uid: string;
  hours: number;
  count: number;
  health: HealthPoint[];
}

export interface ConfigResponse {
  device_uid: string;
  config: Partial<DeviceConfig>;
  schema: Record<string, { type: string; min?: number; max?: number; values?: string[] }>;
}

export interface CommandResponse {
  command_id: string;
  device_uid: string;
  cmd: CommandType;
  params?: Record<string, unknown>;
  status: CommandStatus;
  queued_at: string;
}

/**
 * User interface
 */
export interface User {
  username: string;
  email: string;
  groups: string[];
}

/**
 * Activity feed item
 */
export interface ActivityItem {
  id: string;
  type: 'location' | 'telemetry' | 'alert' | 'command' | 'status';
  device_uid: string;
  device_name?: string;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
