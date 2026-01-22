import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Map, { Marker, Popup, NavigationControl } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin, Calendar, Hash } from 'lucide-react';
import { usePreferences } from '@/contexts/PreferencesContext';
import { formatDateTime } from '@/utils/formatters';
import type { VisitedCity } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

// Map style URLs
const MAP_STYLES = {
  street: 'mapbox://styles/mapbox/light-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

interface VisitedCitiesMapProps {
  cities: VisitedCity[];
  mapboxToken: string;
  className?: string;
  onCitySelect?: (city: VisitedCity) => void;
}

export function VisitedCitiesMap({
  cities,
  mapboxToken,
  className,
  onCitySelect,
}: VisitedCitiesMapProps) {
  const { preferences } = usePreferences();
  const mapStyle = MAP_STYLES[preferences.map_style] || MAP_STYLES.street;

  const mapRef = useRef<MapRef>(null);
  const [hoveredCity, setHoveredCity] = useState<VisitedCity | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Calculate bounds to fit all cities
  const bounds = useMemo(() => {
    if (cities.length === 0) return null;

    const lats = cities.map((c) => c.latitude);
    const lons = cities.map((c) => c.longitude);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [cities]);

  // Fit map to bounds when cities load
  const fitMapToBounds = useCallback(() => {
    if (!mapRef.current || !bounds) return;

    const padding = 50;

    // For single city, just center on it with good zoom
    if (cities.length === 1) {
      mapRef.current.flyTo({
        center: [cities[0].longitude, cities[0].latitude],
        zoom: 10,
        duration: 1000,
      });
    } else {
      // For multiple cities, fit bounds
      mapRef.current.fitBounds(
        [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
        { padding, duration: 1000, maxZoom: 12 }
      );
    }
  }, [bounds, cities]);

  // Fit bounds when cities first load
  useEffect(() => {
    if (cities.length > 0 && !hasInitialized) {
      const timer = setTimeout(() => {
        fitMapToBounds();
        setHasInitialized(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [cities, hasInitialized, fitMapToBounds]);

  // Get marker size based on visit count (scaled logarithmically)
  const getMarkerSize = (visitCount: number) => {
    const minSize = 24;
    const maxSize = 48;
    const scale = Math.log10(visitCount + 1) / Math.log10(100); // Normalize to 0-1 for up to ~100 visits
    return Math.min(maxSize, minSize + scale * (maxSize - minSize));
  };

  // Get marker color based on visit count
  const getMarkerColor = (visitCount: number) => {
    if (visitCount >= 50) return 'text-purple-600';
    if (visitCount >= 20) return 'text-blue-600';
    if (visitCount >= 10) return 'text-green-600';
    if (visitCount >= 5) return 'text-yellow-600';
    return 'text-gray-500';
  };

  // Default center (Austin, TX)
  const defaultCenter = { longitude: -97.7431, latitude: 30.2672 };

  return (
    <div className={className}>
      <Map
        ref={mapRef}
        initialViewState={{
          ...defaultCenter,
          zoom: 4,
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={mapStyle}
        mapboxAccessToken={mapboxToken}
      >
        <NavigationControl position="top-right" />

        {cities.map((city) => {
          const size = getMarkerSize(city.visitCount);
          const colorClass = getMarkerColor(city.visitCount);

          return (
            <Marker
              key={`${city.cityName}-${city.state || ''}`}
              longitude={city.longitude}
              latitude={city.latitude}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                onCitySelect?.(city);
              }}
            >
              <div
                className="cursor-pointer transition-transform hover:scale-110 relative"
                onMouseEnter={() => setHoveredCity(city)}
                onMouseLeave={() => setHoveredCity(null)}
              >
                <MapPin
                  className={colorClass}
                  style={{ width: size, height: size }}
                  fill="currentColor"
                  strokeWidth={1.5}
                  stroke="white"
                />
                {city.visitCount > 1 && (
                  <div
                    className="absolute -top-1 -right-1 bg-white rounded-full px-1 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold text-gray-700 shadow-sm border border-gray-200"
                  >
                    {city.visitCount > 99 ? '99+' : city.visitCount}
                  </div>
                )}
              </div>
            </Marker>
          );
        })}

        {hoveredCity && (
          <Popup
            longitude={hoveredCity.longitude}
            latitude={hoveredCity.latitude}
            anchor="top"
            closeButton={false}
            closeOnClick={false}
            offset={20}
          >
            <div className="p-2 min-w-[180px]">
              <h4 className="font-semibold text-sm mb-2">
                {hoveredCity.cityName}
                {hoveredCity.state && `, ${hoveredCity.state}`}
              </h4>

              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" />
                  <span>
                    Checked in <strong className="text-foreground">{hoveredCity.visitCount}</strong> time{hoveredCity.visitCount !== 1 ? 's' : ''}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>First: {formatDateTime(hoveredCity.firstVisit)}</span>
                </div>

                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>Last: {formatDateTime(hoveredCity.lastVisit)}</span>
                </div>
              </div>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}
