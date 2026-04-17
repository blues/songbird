/**
 * Shared display preferences defaults
 */

import type { DisplayPreferences } from '@/types';

export const DEFAULT_PREFERENCES: DisplayPreferences = {
  temp_unit: 'celsius',
  time_format: '24h',
  default_time_range: '24',
  map_style: 'street',
  distance_unit: 'km',
};
