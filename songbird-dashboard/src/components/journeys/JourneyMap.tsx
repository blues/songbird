import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin, Play, Pause, RotateCcw, FastForward, Navigation, Gauge, Target, Clock, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { JourneyPoint } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAP_STYLES = {
  street: 'mapbox://styles/mapbox/light-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

const PLAYBACK_SPEEDS = [1, 2, 5, 10];

interface JourneyMapProps {
  points: JourneyPoint[];
  mapboxToken: string;
  className?: string;
}

export function JourneyMap({ points, mapboxToken, className }: JourneyMapProps) {
  const { preferences } = usePreferences();
  const mapStyle = MAP_STYLES[preferences.map_style] || MAP_STYLES.street;

  const mapRef = useRef<MapRef>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Current point being displayed
  const currentPoint = points[currentIndex];

  // Create GeoJSON for the complete trail
  const completeTrailGeoJson = useMemo(() => {
    if (points.length < 2) return null;

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: points.map((p) => [p.lon, p.lat]),
      },
    };
  }, [points]);

  // Create GeoJSON for the progress trail (up to current point)
  const progressTrailGeoJson = useMemo(() => {
    if (currentIndex < 1) return null;

    const progressPoints = points.slice(0, currentIndex + 1);
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: progressPoints.map((p) => [p.lon, p.lat]),
      },
    };
  }, [points, currentIndex]);

  // Calculate bounds for the view
  const bounds = useMemo(() => {
    if (points.length === 0) return null;

    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [points]);

  // Fit map to journey when data loads
  const fitMapToJourney = useCallback(() => {
    if (!mapRef.current || !bounds) return;

    const hasSpread =
      bounds.maxLat - bounds.minLat > 0.001 ||
      bounds.maxLon - bounds.minLon > 0.001;

    if (hasSpread) {
      mapRef.current.fitBounds(
        [
          [bounds.minLon, bounds.minLat],
          [bounds.maxLon, bounds.maxLat],
        ],
        { padding: 50, duration: 1000, maxZoom: 16 }
      );
    } else {
      mapRef.current.flyTo({
        center: [bounds.minLon, bounds.minLat],
        zoom: 14,
        duration: 1000,
      });
    }
  }, [bounds]);

  // Initialize map view
  useEffect(() => {
    if (points.length > 0 && !hasInitialized) {
      const timer = setTimeout(() => {
        fitMapToJourney();
        setHasInitialized(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [points, hasInitialized, fitMapToJourney]);

  // Animation loop for playback
  useEffect(() => {
    if (!isPlaying) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    const animate = (timestamp: number) => {
      if (!lastFrameTimeRef.current) {
        lastFrameTimeRef.current = timestamp;
      }

      const elapsed = timestamp - lastFrameTimeRef.current;
      // Advance based on playback speed (roughly 1 point per 500ms at 1x)
      const frameInterval = 500 / playbackSpeed;

      if (elapsed >= frameInterval) {
        lastFrameTimeRef.current = timestamp;
        setCurrentIndex((prev) => {
          const next = prev + 1;
          if (next >= points.length) {
            setIsPlaying(false);
            return points.length - 1;
          }
          return next;
        });
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, playbackSpeed, points.length]);

  // Reset playback
  const handleReset = () => {
    setIsPlaying(false);
    setCurrentIndex(0);
    lastFrameTimeRef.current = 0;
  };

  // Toggle playback
  const handlePlayPause = () => {
    if (currentIndex >= points.length - 1) {
      handleReset();
      setIsPlaying(true);
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  // Cycle through playback speeds
  const handleSpeedChange = () => {
    const currentSpeedIndex = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    const nextSpeedIndex = (currentSpeedIndex + 1) % PLAYBACK_SPEEDS.length;
    setPlaybackSpeed(PLAYBACK_SPEEDS[nextSpeedIndex]);
  };

  // Handle slider change
  const handleSliderChange = (value: number[]) => {
    setCurrentIndex(value[0]);
  };

  // Format velocity for display
  const formatVelocity = (velocity?: number) => {
    if (velocity === undefined) return '--';
    // Convert m/s to km/h
    const kmh = velocity * 3.6;
    return `${kmh.toFixed(1)} km/h`;
  };

  // Format bearing for display
  const formatBearing = (bearing?: number) => {
    if (bearing === undefined) return '--';
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(bearing / 45) % 8;
    return `${directions[index]} (${bearing.toFixed(0)}°)`;
  };

  // Format distance for display
  const formatDistance = (distance?: number) => {
    if (distance === undefined) return '--';
    if (distance < 1000) {
      return `${distance.toFixed(0)} m`;
    }
    return `${(distance / 1000).toFixed(2)} km`;
  };

  // Format DOP (GPS accuracy) for display
  const formatDOP = (dop?: number) => {
    if (dop === undefined) return '--';
    if (dop <= 1) return `${dop.toFixed(1)} (Excellent)`;
    if (dop <= 2) return `${dop.toFixed(1)} (Good)`;
    if (dop <= 5) return `${dop.toFixed(1)} (Moderate)`;
    if (dop <= 10) return `${dop.toFixed(1)} (Fair)`;
    return `${dop.toFixed(1)} (Poor)`;
  };

  // Get selected point for popup
  const selectedPoint = selectedPointIndex !== null ? points[selectedPointIndex] : null;

  // Default center (Austin, TX)
  const defaultCenter = { latitude: 30.2672, longitude: -97.7431 };

  if (points.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <span className="text-muted-foreground">No journey data available</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Map */}
      <div className="flex-1 min-h-[300px]">
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

          {/* Complete trail (faded) */}
          {completeTrailGeoJson && (
            <Source id="complete-trail" type="geojson" data={completeTrailGeoJson}>
              <Layer
                id="complete-trail-line"
                type="line"
                paint={{
                  'line-color': '#94a3b8',
                  'line-width': 2,
                  'line-opacity': 0.4,
                  'line-dasharray': [2, 2],
                }}
              />
            </Source>
          )}

          {/* Progress trail (solid) */}
          {progressTrailGeoJson && (
            <Source id="progress-trail" type="geojson" data={progressTrailGeoJson}>
              <Layer
                id="progress-trail-line"
                type="line"
                paint={{
                  'line-color': '#0066CC',
                  'line-width': 3,
                  'line-opacity': 0.8,
                }}
              />
            </Source>
          )}

          {/* Start marker */}
          {points.length > 0 && (
            <Marker
              longitude={points[0].lon}
              latitude={points[0].lat}
              anchor="center"
            >
              <div className="w-3 h-3 rounded-full bg-green-500 border-2 border-white shadow" />
            </Marker>
          )}

          {/* End marker (if not at current position) */}
          {points.length > 1 && currentIndex < points.length - 1 && (
            <Marker
              longitude={points[points.length - 1].lon}
              latitude={points[points.length - 1].lat}
              anchor="center"
            >
              <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-white shadow" />
            </Marker>
          )}

          {/* Current position marker */}
          {currentPoint && (
            <Marker
              longitude={currentPoint.lon}
              latitude={currentPoint.lat}
              anchor="bottom"
            >
              <MapPin
                className="h-8 w-8 text-blue-500"
                fill="currentColor"
                strokeWidth={1.5}
                stroke="white"
              />
            </Marker>
          )}

          {/* Clickable point markers */}
          {points.map((point, index) => (
            <Marker
              key={`point-${index}`}
              longitude={point.lon}
              latitude={point.lat}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                setSelectedPointIndex(index);
                // Pan map to ensure popup is visible (with top padding for popup height)
                if (mapRef.current) {
                  mapRef.current.easeTo({
                    center: [point.lon, point.lat],
                    padding: { top: 300, bottom: 50, left: 50, right: 50 },
                    duration: 300,
                  });
                }
              }}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full border border-white shadow cursor-pointer transition-all hover:scale-150 ${
                  index === 0
                    ? 'bg-green-500'
                    : index === points.length - 1
                    ? 'bg-red-500'
                    : index <= currentIndex
                    ? 'bg-blue-500'
                    : 'bg-slate-400'
                }`}
              />
            </Marker>
          ))}

          {/* Point detail popup */}
          {selectedPoint && selectedPointIndex !== null && (
            <Popup
              longitude={selectedPoint.lon}
              latitude={selectedPoint.lat}
              anchor="bottom"
              offset={15}
              closeOnClick={false}
              onClose={() => setSelectedPointIndex(null)}
              className="journey-point-popup"
            >
              <div className="p-2 min-w-[200px]">
                <div className="flex items-center justify-between mb-2 pb-2 border-b">
                  <span className="font-semibold text-sm">Point {selectedPoint.jcount}</span>
                  <Badge variant="outline" className="text-xs ml-4">
                    {selectedPointIndex + 1} / {points.length}
                  </Badge>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span>{new Date(selectedPoint.time).toLocaleString()}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <MapPin className="h-3 w-3 text-muted-foreground" />
                    <span>{selectedPoint.lat.toFixed(6)}, {selectedPoint.lon.toFixed(6)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Gauge className="h-3 w-3 text-muted-foreground" />
                    <span>Speed: {formatVelocity(selectedPoint.velocity)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Navigation className="h-3 w-3 text-muted-foreground" />
                    <span>Heading: {formatBearing(selectedPoint.bearing)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Route className="h-3 w-3 text-muted-foreground" />
                    <span>Distance: {formatDistance(selectedPoint.distance)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Target className="h-3 w-3 text-muted-foreground" />
                    <span>Accuracy: {formatDOP(selectedPoint.dop)}</span>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      setCurrentIndex(selectedPointIndex);
                      setSelectedPointIndex(null);
                    }}
                  >
                    Jump to this point
                  </Button>
                </div>
              </div>
            </Popup>
          )}
        </Map>
      </div>

      {/* Playback controls */}
      <div className="p-4 border-t bg-background">
        {/* Current point info */}
        <div className="flex items-center justify-between mb-3 text-sm">
          <div className="flex gap-4">
            <Badge variant="outline">
              Point {currentIndex + 1} / {points.length}
            </Badge>
            {currentPoint && (
              <>
                <span className="text-muted-foreground">
                  Speed: {formatVelocity(currentPoint.velocity)}
                </span>
                <span className="text-muted-foreground">
                  Heading: {formatBearing(currentPoint.bearing)}
                </span>
              </>
            )}
          </div>
          {currentPoint && (
            <span className="text-muted-foreground">
              {new Date(currentPoint.time).toLocaleString()}
            </span>
          )}
        </div>

        {/* Timeline slider */}
        <div className="mb-3">
          <Slider
            value={[currentIndex]}
            min={0}
            max={points.length - 1}
            step={1}
            onValueChange={handleSliderChange}
            disabled={points.length <= 1}
          />
        </div>

        {/* Control buttons */}
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={handleReset}
            title="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>

          <Button
            variant="default"
            size="icon"
            onClick={handlePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSpeedChange}
            title="Change speed"
            className="min-w-[60px]"
          >
            <FastForward className="h-4 w-4 mr-1" />
            {playbackSpeed}x
          </Button>
        </div>
      </div>
    </div>
  );
}
