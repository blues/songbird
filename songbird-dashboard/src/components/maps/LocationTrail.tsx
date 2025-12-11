import { useMemo } from 'react';
import Map, { Source, Layer, Marker, NavigationControl } from 'react-map-gl';
import { MapPin } from 'lucide-react';
import type { LocationPoint } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

interface LocationTrailProps {
  locations: LocationPoint[];
  mapboxToken: string;
  className?: string;
}

export function LocationTrail({
  locations,
  mapboxToken,
  className,
}: LocationTrailProps) {
  // Create GeoJSON for the trail line
  const trailGeoJson = useMemo(() => {
    if (locations.length < 2) return null;

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: locations.map((loc) => [loc.lon, loc.lat]),
      },
    };
  }, [locations]);

  // Calculate bounds for the view
  const bounds = useMemo(() => {
    if (locations.length === 0) return null;

    const lats = locations.map((l) => l.lat);
    const lons = locations.map((l) => l.lon);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [locations]);

  // Calculate center
  const center = bounds
    ? {
        latitude: (bounds.minLat + bounds.maxLat) / 2,
        longitude: (bounds.minLon + bounds.maxLon) / 2,
      }
    : { latitude: 30.2672, longitude: -97.7431 };

  // Calculate zoom based on bounds
  const zoom = bounds
    ? Math.min(
        14,
        Math.max(
          6,
          Math.floor(
            14 -
              Math.log2(
                Math.max(
                  bounds.maxLat - bounds.minLat,
                  bounds.maxLon - bounds.minLon
                ) * 100
              )
          )
        )
      )
    : 12;

  const currentLocation = locations[0];
  const trailPoints = locations.slice(1);

  return (
    <div className={className}>
      <Map
        initialViewState={{
          ...center,
          zoom,
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle="mapbox://styles/mapbox/light-v11"
        mapboxAccessToken={mapboxToken}
      >
        <NavigationControl position="top-right" />

        {/* Trail line */}
        {trailGeoJson && (
          <Source id="trail" type="geojson" data={trailGeoJson}>
            <Layer
              id="trail-line"
              type="line"
              paint={{
                'line-color': '#0066CC',
                'line-width': 3,
                'line-opacity': 0.7,
              }}
            />
          </Source>
        )}

        {/* Trail points */}
        {trailPoints.map((point, index) => (
          <Marker
            key={`${point.time}-${index}`}
            longitude={point.lon}
            latitude={point.lat}
            anchor="center"
          >
            <div
              className="w-2 h-2 rounded-full bg-blues-500 opacity-50"
              style={{
                opacity: 0.3 + (0.5 * (trailPoints.length - index)) / trailPoints.length,
              }}
            />
          </Marker>
        ))}

        {/* Current location marker */}
        {currentLocation && (
          <Marker
            longitude={currentLocation.lon}
            latitude={currentLocation.lat}
            anchor="bottom"
          >
            <MapPin
              className="h-8 w-8 text-green-500"
              fill="currentColor"
              strokeWidth={1.5}
              stroke="white"
            />
          </Marker>
        )}
      </Map>
    </div>
  );
}
