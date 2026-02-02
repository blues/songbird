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
export type CommandType = 'ping' | 'locate' | 'play_melody' | 'test_audio' | 'set_volume' | 'unlock';

// Command status
export type CommandStatus = 'queued' | 'sent' | 'ok' | 'error' | 'ignored';

// Location source (how location was determined)
export type LocationSource = 'gps' | 'cell' | 'wifi' | 'triangulation' | 'tower';

/**
 * Device interface
 */
export interface Device {
  serial_number: string;
  device_uid: string;
  device_uid_history?: string[];
  name?: string;
  fleet_uid?: string;
  fleet_name?: string;
  assigned_to?: string;
  assigned_to_name?: string;
  status: DeviceStatus;
  last_seen?: string;
  mode: OperatingMode;
  transit_locked?: boolean;
  demo_locked?: boolean;
  gps_power_saving?: boolean;
  gps_no_sat?: boolean;
  usb_powered?: boolean;
  firmware_version?: string;
  notecard_version?: string;
  notecard_sku?: string;
  // Latest telemetry
  temperature?: number;
  humidity?: number;
  pressure?: number;
  voltage?: number;
  // Latest location
  latitude?: number;
  longitude?: number;
  location_time?: string;
  location_source?: LocationSource;
  location_name?: string;
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
 * Note: voltage is no longer included; battery info comes from power data (_log.qo)
 */
export interface TelemetryPoint {
  time: string;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  motion?: boolean;
}

/**
 * Location data point
 */
export interface LocationPoint {
  time: string;
  lat: number;
  lon: number;
  source?: LocationSource;
}

/**
 * Mojo power monitoring data point
 */
export interface PowerPoint {
  time: string;
  voltage?: number;
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
  serial_number?: string;
  cmd: CommandType;
  params?: Record<string, unknown>;
  status: CommandStatus;
  created_at: string | number;
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
  // GPS Power Management (actively manages GPS based on signal)
  gps_power_save_enabled?: boolean;
  gps_signal_timeout_min?: number;
  gps_retry_interval_min?: number;
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

/**
 * GeoJSON LineString geometry (for matched routes)
 */
export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][]; // [lon, lat][]
}

/**
 * Journey (GPS tracking trip)
 */
export interface Journey {
  journey_id: number;     // Unix timestamp of journey start
  device_uid: string;
  start_time: string;     // ISO string
  end_time?: string;      // ISO string
  point_count: number;
  total_distance: number; // meters
  status: 'active' | 'completed';
  matched_route?: GeoJSONLineString; // Road-snapped route from Mapbox Map Matching
  matched_points_count?: number; // Number of points when matched_route was computed
}

/**
 * Journey point (GPS location within a journey)
 */
export interface JourneyPoint {
  time: string;
  lat: number;
  lon: number;
  velocity?: number;      // m/s
  bearing?: number;       // degrees from north
  distance?: number;      // meters from previous point
  dop?: number;           // GPS accuracy (lower = better)
  jcount: number;         // point number in journey (starts at 1)
}

/**
 * Location history point (all location sources)
 */
export interface LocationHistoryPoint {
  time: string;
  lat: number;
  lon: number;
  source: LocationSource;
  location_name?: string;
  event_type?: string;
  journey_id?: number;
  jcount?: number;
  velocity?: number;
  bearing?: number;
}

export interface JourneysResponse {
  device_uid: string;
  journeys: Journey[];
  count: number;
}

/**
 * Power consumption data for a journey
 */
export interface JourneyPower {
  start_mah: number;
  end_mah: number;
  consumed_mah: number;
  reading_count: number;
}

export interface JourneyDetailResponse {
  journey: Journey;
  points: JourneyPoint[];
  power?: JourneyPower;
}

/**
 * Map matching response
 */
export interface MapMatchResponse {
  matched_route: GeoJSONLineString;
  confidence: number;
  original_points: number;
  matched_points: number;
}

export interface LocationHistoryResponse {
  device_uid: string;
  hours: number;
  count: number;
  locations: LocationHistoryPoint[];
}

/**
 * Visited city - aggregated location data at city level
 */
export interface VisitedCity {
  cityName: string;
  state?: string;
  country?: string;
  latitude: number;
  longitude: number;
  visitCount: number;
  firstVisit: string;
  lastVisit: string;
}

export interface VisitedCitiesResponse {
  serial_number: string;
  cities: VisitedCity[];
  totalLocations: number;
  dateRange: {
    from: string | null;
    to: string | null;
  };
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
  type: 'alert' | 'health' | 'command' | 'journey' | 'mode_change';
  device_uid: string;
  device_name?: string;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * User group types
 */
export type UserGroup = 'Admin' | 'Sales' | 'FieldEngineering' | 'Viewer';

/**
 * User info from Cognito (for admin user management)
 */
export interface UserInfo {
  username: string;
  email: string;
  name: string;
  status: string;
  created_at: string;
  groups: UserGroup[];
  assigned_devices?: string[];
}

/**
 * Display preferences (stored in Cognito user attributes)
 */
export interface DisplayPreferences {
  temp_unit: 'celsius' | 'fahrenheit';
  time_format: '12h' | '24h';
  default_time_range: '1' | '4' | '8' | '12' | '24' | '48' | '168';
  map_style: 'street' | 'satellite';
  distance_unit: 'km' | 'mi';
}

/**
 * Fleet defaults configuration
 */
export interface FleetDefaults {
  fleet_uid: string;
  mode?: OperatingMode;
  gps_interval_min?: number;
  sync_interval_min?: number;
  heartbeat_hours?: number;
  temp_alert_high_c?: number;
  temp_alert_low_c?: number;
  humidity_alert_high?: number;
  humidity_alert_low?: number;
  voltage_alert_low?: number;
  motion_sensitivity?: MotionSensitivity;
  audio_enabled?: boolean;
  led_enabled?: boolean;
  // GPS Power Management (actively manages GPS based on signal)
  gps_power_save_enabled?: boolean;
  gps_signal_timeout_min?: number;
  gps_retry_interval_min?: number;
  updated_at?: number;
  updated_by?: string;
}

/**
 * Notehub route info
 */
export interface NotehubRoute {
  uid: string;
  name: string;
  type: string;
  url?: string;
  enabled: boolean;
  modified: string;
}

/**
 * Notehub fleet info
 */
export interface NotehubFleet {
  uid: string;
  name: string;
  created: string;
}

/**
 * Notehub connection status
 */
export interface NotehubStatus {
  project: {
    uid: string;
    name: string;
    created?: string;
  };
  routes: NotehubRoute[];
  fleets: NotehubFleet[];
  device_count: number;
  health: 'healthy' | 'warning' | 'error';
  error?: string;
  last_checked: string;
}

/**
 * Host firmware info from Notehub
 */
export interface HostFirmware {
  filename: string;
  version?: string;
  created: string;
  type: string;
  target?: string;
  md5?: string;
  size?: number;
}

/**
 * Firmware update target type
 */
export type FirmwareUpdateTarget = 'all' | 'fleet' | 'device';

/**
 * Request to queue a firmware update
 */
export interface FirmwareUpdateRequest {
  filename: string;
  fleetUID?: string;
  deviceUID?: string;
}

/**
 * Device DFU status update entry
 */
export interface DfuUpdateEntry {
  when: string;
  status: string;
}

/**
 * Device DFU status
 */
export interface DeviceDfuStatus {
  device_uid: string;
  serial_number?: string;
  current_version?: string;
  requested_version?: string;
  status?: string;
  began?: string;
  updates?: DfuUpdateEntry[];
}

/**
 * Overall DFU status response
 */
export interface DfuStatus {
  firmware_type: string;
  devices: DeviceDfuStatus[];
}

/**
 * Host firmware list response
 */
export interface HostFirmwareResponse {
  firmware: HostFirmware[];
}
