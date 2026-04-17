/**
 * Shared map configuration constants
 */

export const MAP_STYLES = {
  street: 'mapbox://styles/mapbox/light-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;

export const DEFAULT_MAP_CENTER = { longitude: -97.7431, latitude: 30.2672 } as const;
