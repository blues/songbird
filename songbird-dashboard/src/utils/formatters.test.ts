/**
 * Tests for formatting utilities
 */

import { describe, it, expect } from 'vitest';
import {
  celsiusToFahrenheit,
  formatTemperature,
  convertTemperature,
  getTemperatureUnit,
  formatHumidity,
  formatPressure,
  formatBattery,
  formatCoordinates,
  formatSignal,
  formatMode,
  truncateDeviceUid,
  formatDate,
  formatTime,
  formatDateTime,
} from './formatters';

describe('celsiusToFahrenheit', () => {
  it('converts 0C to 32F', () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
  });

  it('converts 100C to 212F', () => {
    expect(celsiusToFahrenheit(100)).toBe(212);
  });

  it('converts negative temperatures', () => {
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });
});

describe('formatTemperature', () => {
  it('formats in Celsius by default', () => {
    expect(formatTemperature(25.123)).toBe('25.1°C');
  });

  it('formats in Fahrenheit', () => {
    expect(formatTemperature(0, 'F')).toBe('32.0°F');
  });

  it('returns -- for undefined', () => {
    expect(formatTemperature(undefined)).toBe('--');
  });
});

describe('convertTemperature', () => {
  it('returns Celsius unchanged', () => {
    expect(convertTemperature(25, 'C')).toBe(25);
  });

  it('converts to Fahrenheit', () => {
    expect(convertTemperature(0, 'F')).toBe(32);
  });

  it('returns undefined for undefined input', () => {
    expect(convertTemperature(undefined)).toBeUndefined();
  });
});

describe('getTemperatureUnit', () => {
  it('returns °C for Celsius', () => {
    expect(getTemperatureUnit('C')).toBe('°C');
  });

  it('returns °F for Fahrenheit', () => {
    expect(getTemperatureUnit('F')).toBe('°F');
  });
});

describe('formatHumidity', () => {
  it('formats with percentage', () => {
    expect(formatHumidity(65.789)).toBe('65.8%');
  });

  it('returns -- for undefined', () => {
    expect(formatHumidity(undefined)).toBe('--');
  });
});

describe('formatPressure', () => {
  it('formats with unit', () => {
    expect(formatPressure(1013.25)).toBe('1013.3 hPa');
  });

  it('returns -- for undefined', () => {
    expect(formatPressure(undefined)).toBe('--');
  });
});

describe('formatBattery', () => {
  it('returns full for high voltage', () => {
    const result = formatBattery(4.2);
    expect(result.level).toBe('full');
    expect(result.percentage).toBe(100);
    expect(result.voltage).toBe('4.20V');
  });

  it('returns good for mid voltage', () => {
    const result = formatBattery(3.6);
    expect(result.level).toBe('good');
    expect(result.percentage).toBe(50);
  });

  it('returns low for lower voltage', () => {
    const result = formatBattery(3.2);
    expect(result.level).toBe('low');
  });

  it('returns critical for very low voltage', () => {
    const result = formatBattery(3.0);
    expect(result.level).toBe('critical');
    expect(result.percentage).toBe(0);
  });

  it('clamps percentage to 0-100', () => {
    expect(formatBattery(5.0).percentage).toBe(100);
    expect(formatBattery(2.0).percentage).toBe(0);
  });

  it('handles undefined', () => {
    const result = formatBattery(undefined);
    expect(result.voltage).toBe('--');
    expect(result.percentage).toBe(0);
    expect(result.level).toBe('critical');
  });
});

describe('formatCoordinates', () => {
  it('formats north-east coordinates', () => {
    expect(formatCoordinates(40.7128, -74.006)).toBe('40.71280°N, 74.00600°W');
  });

  it('formats south-west coordinates', () => {
    expect(formatCoordinates(-33.8688, 151.2093)).toBe('33.86880°S, 151.20930°E');
  });
});

describe('formatSignal', () => {
  it('returns excellent for strong signal', () => {
    expect(formatSignal(-45).level).toBe('excellent');
  });

  it('returns good for decent signal', () => {
    expect(formatSignal(-55).level).toBe('good');
  });

  it('returns fair for moderate signal', () => {
    expect(formatSignal(-65).level).toBe('fair');
  });

  it('returns poor for weak signal', () => {
    expect(formatSignal(-80).level).toBe('poor');
  });
});

describe('formatMode', () => {
  it('capitalizes known modes', () => {
    expect(formatMode('demo')).toBe('Demo');
    expect(formatMode('transit')).toBe('Transit');
    expect(formatMode('storage')).toBe('Storage');
    expect(formatMode('sleep')).toBe('Sleep');
  });

  it('returns raw value for unknown mode', () => {
    expect(formatMode('custom')).toBe('custom');
  });
});

describe('truncateDeviceUid', () => {
  it('truncates dev: prefixed UIDs', () => {
    expect(truncateDeviceUid('dev:1234567890ab')).toBe('...567890ab');
  });

  it('truncates long non-dev UIDs', () => {
    expect(truncateDeviceUid('abcdefghijklmnop')).toBe('abcdef...mnop');
  });

  it('leaves short UIDs untouched', () => {
    expect(truncateDeviceUid('short')).toBe('short');
  });
});

describe('formatDate', () => {
  it('formats Date objects', () => {
    const date = new Date(2025, 0, 15); // Jan 15, 2025
    expect(formatDate(date)).toBe('Jan 15, 2025');
  });

  it('formats ISO strings', () => {
    expect(formatDate('2025-06-01T00:00:00.000Z')).toMatch(/Jun 1, 2025|May 31, 2025/);
  });
});

describe('formatTime', () => {
  it('formats time from Date', () => {
    const date = new Date(2025, 0, 15, 14, 30, 45);
    expect(formatTime(date)).toBe('14:30:45');
  });
});

describe('formatDateTime', () => {
  it('formats date and time from Date', () => {
    const date = new Date(2025, 0, 15, 14, 30);
    expect(formatDateTime(date)).toBe('Jan 15, 2025 14:30');
  });
});
