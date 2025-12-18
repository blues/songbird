import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import Map, { Source, Layer, Marker, NavigationControl } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin } from 'lucide-react';
import type { LocationPoint } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

interface LocationTrailProps {
  locations: LocationPoint[];
  currentLocation?: { lat: number; lon: number };
  mapboxToken: string;
  className?: string;
}

export function LocationTrail({
  locations,
  currentLocation: deviceLocation,
  mapboxToken,
  className,
}: LocationTrailProps) {
  const mapRef = useRef<MapRef>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

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
    if (locations.length === 0 && !deviceLocation) return null;

    const allPoints = deviceLocation
      ? [{ lat: deviceLocation.lat, lon: deviceLocation.lon }, ...locations]
      : locations;

    if (allPoints.length === 0) return null;

    const lats = allPoints.map((l) => l.lat);
    const lons = allPoints.map((l) => l.lon);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [locations, deviceLocation]);

  // Fit map to location when data loads
  const fitMapToLocation = useCallback(() => {
    if (!mapRef.current) return;

    // If we have a device location but no trail, center on device
    if (deviceLocation && locations.length === 0) {
      mapRef.current.flyTo({
        center: [deviceLocation.lon, deviceLocation.lat],
        zoom: 12,
        duration: 1000,
      });
      return;
    }

    // If we have trail locations, fit bounds
    if (bounds) {
      const hasSpread = (bounds.maxLat - bounds.minLat > 0.001) ||
                        (bounds.maxLon - bounds.minLon > 0.001);

      if (hasSpread) {
        mapRef.current.fitBounds(
          [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
          { padding: 50, duration: 1000, maxZoom: 14 }
        );
      } else {
        // All points are basically the same, just center
        mapRef.current.flyTo({
          center: [bounds.minLon, bounds.minLat],
          zoom: 12,
          duration: 1000,
        });
      }
    }
  }, [bounds, deviceLocation, locations.length]);

  // Fit to location when data first loads
  useEffect(() => {
    const hasData = locations.length > 0 || deviceLocation;
    if (hasData && !hasInitialized) {
      const timer = setTimeout(() => {
        fitMapToLocation();
        setHasInitialized(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [locations, deviceLocation, hasInitialized, fitMapToLocation]);

  const currentLocation = locations[0] || (deviceLocation ? { lat: deviceLocation.lat, lon: deviceLocation.lon, time: '' } : null);
  const trailPoints = locations.slice(1);

  // Default center (Austin, TX)
  const defaultCenter = { latitude: 30.2672, longitude: -97.7431 };

  return (
    <div className={className}>
      <Map
        ref={mapRef}
        initialViewState={{
          ...defaultCenter,
          zoom: 4,
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
