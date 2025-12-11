/**
 * Formatting utilities for the dashboard
 */

import { formatDistanceToNow, format, parseISO } from 'date-fns';

/**
 * Format a timestamp as relative time (e.g., "2 minutes ago")
 */
export function formatRelativeTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Format a timestamp as a date string
 */
export function formatDate(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  return format(date, 'MMM d, yyyy');
}

/**
 * Format a timestamp as a time string
 */
export function formatTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  return format(date, 'HH:mm:ss');
}

/**
 * Format a timestamp as date and time
 */
export function formatDateTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  return format(date, 'MMM d, yyyy HH:mm');
}

/**
 * Format temperature with unit
 */
export function formatTemperature(value: number | undefined, unit: 'C' | 'F' = 'C'): string {
  if (value === undefined) return '--';
  const formatted = unit === 'F' ? (value * 9) / 5 + 32 : value;
  return `${formatted.toFixed(1)}°${unit}`;
}

/**
 * Format humidity with unit
 */
export function formatHumidity(value: number | undefined): string {
  if (value === undefined) return '--';
  return `${value.toFixed(1)}%`;
}

/**
 * Format pressure with unit
 */
export function formatPressure(value: number | undefined): string {
  if (value === undefined) return '--';
  return `${value.toFixed(1)} hPa`;
}

/**
 * Format battery voltage with percentage estimate
 */
export function formatBattery(voltage: number | undefined): {
  voltage: string;
  percentage: number;
  level: 'full' | 'good' | 'low' | 'critical';
} {
  if (voltage === undefined) {
    return { voltage: '--', percentage: 0, level: 'critical' };
  }

  // Estimate percentage based on LiPo discharge curve
  // Full: 4.2V, Empty: 3.0V
  const percentage = Math.round(Math.max(0, Math.min(100, ((voltage - 3.0) / 1.2) * 100)));

  let level: 'full' | 'good' | 'low' | 'critical';
  if (percentage > 75) level = 'full';
  else if (percentage > 40) level = 'good';
  else if (percentage > 15) level = 'low';
  else level = 'critical';

  return {
    voltage: `${voltage.toFixed(2)}V`,
    percentage,
    level,
  };
}

/**
 * Format coordinates
 */
export function formatCoordinates(lat: number, lon: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${latDir}, ${Math.abs(lon).toFixed(5)}°${lonDir}`;
}

/**
 * Format signal strength
 */
export function formatSignal(rssi: number): {
  text: string;
  level: 'excellent' | 'good' | 'fair' | 'poor';
} {
  let level: 'excellent' | 'good' | 'fair' | 'poor';
  let text: string;

  if (rssi >= -50) {
    level = 'excellent';
    text = 'Excellent';
  } else if (rssi >= -60) {
    level = 'good';
    text = 'Good';
  } else if (rssi >= -70) {
    level = 'fair';
    text = 'Fair';
  } else {
    level = 'poor';
    text = 'Poor';
  }

  return { text, level };
}

/**
 * Format operating mode for display
 */
export function formatMode(mode: string): string {
  const modes: Record<string, string> = {
    demo: 'Demo',
    transit: 'Transit',
    storage: 'Storage',
    sleep: 'Sleep',
  };
  return modes[mode] || mode;
}

/**
 * Truncate device UID for display
 */
export function truncateDeviceUid(uid: string): string {
  if (uid.startsWith('dev:')) {
    return `...${uid.slice(-8)}`;
  }
  return uid.length > 12 ? `${uid.slice(0, 6)}...${uid.slice(-4)}` : uid;
}
