import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin, Play, Pause, RotateCcw, FastForward, Navigation, Gauge, Target, Clock, Route, SkipBack, SkipForward, Waypoints, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { JourneyPoint, GeoJSONLineString } from '@/types';
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
  matchedRoute?: GeoJSONLineString;
  onMatchRoute?: () => void;
  isMatching?: boolean;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate cumulative distances along a route
 */
function calculateRouteDistances(coordinates: [number, number][]): number[] {
  const distances: number[] = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const [lon1, lat1] = coordinates[i - 1];
    const [lon2, lat2] = coordinates[i];
    const segmentDist = haversineDistance(lat1, lon1, lat2, lon2);
    distances.push(distances[i - 1] + segmentDist);
  }
  return distances;
}

/**
 * Get position along route at a given distance
 */
function getPositionAtDistance(
  coordinates: [number, number][],
  distances: number[],
  targetDistance: number
): { lon: number; lat: number } {
  if (targetDistance <= 0) {
    return { lon: coordinates[0][0], lat: coordinates[0][1] };
  }

  const totalDistance = distances[distances.length - 1];
  if (targetDistance >= totalDistance) {
    const last = coordinates[coordinates.length - 1];
    return { lon: last[0], lat: last[1] };
  }

  // Find the segment containing our target distance
  for (let i = 1; i < distances.length; i++) {
    if (distances[i] >= targetDistance) {
      const segmentStart = distances[i - 1];
      const segmentEnd = distances[i];
      const segmentLength = segmentEnd - segmentStart;
      const t = (targetDistance - segmentStart) / segmentLength;

      const [lon1, lat1] = coordinates[i - 1];
      const [lon2, lat2] = coordinates[i];

      return {
        lon: lon1 + t * (lon2 - lon1),
        lat: lat1 + t * (lat2 - lat1),
      };
    }
  }

  // Fallback
  const last = coordinates[coordinates.length - 1];
  return { lon: last[0], lat: last[1] };
}

export function JourneyMap({ points, mapboxToken, className, matchedRoute, onMatchRoute, isMatching }: JourneyMapProps) {
  const { preferences } = usePreferences();
  const mapStyle = MAP_STYLES[preferences.map_style] || MAP_STYLES.street;
  const [showMatchedRoute, setShowMatchedRoute] = useState(true);

  const mapRef = useRef<MapRef>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [hasTriggeredMatch, setHasTriggeredMatch] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [animationProgress, setAnimationProgress] = useState(0); // 0-1 progress within current segment
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Current point being displayed (from GPS data)
  const currentPoint = points[currentIndex];

  // Calculate cumulative distances for GPS points (for timeline mapping)
  const gpsDistances = useMemo(() => {
    if (points.length < 2) return [0];
    const distances: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      const dist = haversineDistance(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      );
      distances.push(distances[i - 1] + dist);
    }
    return distances;
  }, [points]);

  // Calculate cumulative distances for matched route
  const routeDistances = useMemo(() => {
    if (!matchedRoute || matchedRoute.coordinates.length < 2) return null;
    return calculateRouteDistances(matchedRoute.coordinates);
  }, [matchedRoute]);

  const totalRouteDistance = routeDistances ? routeDistances[routeDistances.length - 1] : 0;
  const totalGpsDistance = gpsDistances[gpsDistances.length - 1];

  // Calculate current distance traveled based on currentIndex and progress
  const currentDistanceTraveled = useMemo(() => {
    if (currentIndex === 0) return animationProgress * (gpsDistances[1] || 0);
    if (currentIndex >= points.length - 1) return totalGpsDistance;

    const baseDistance = gpsDistances[currentIndex];
    const segmentDistance = gpsDistances[currentIndex + 1] - gpsDistances[currentIndex];
    return baseDistance + animationProgress * segmentDistance;
  }, [currentIndex, animationProgress, gpsDistances, points.length, totalGpsDistance]);

  // Get current marker position - follows matched route if available
  const currentMarkerPosition = useMemo(() => {
    if (matchedRoute && routeDistances && showMatchedRoute && totalRouteDistance > 0) {
      // Map GPS distance to route distance proportionally
      const routeProgress = currentDistanceTraveled / totalGpsDistance;
      const targetDistance = routeProgress * totalRouteDistance;
      return getPositionAtDistance(matchedRoute.coordinates, routeDistances, targetDistance);
    }

    // Fall back to GPS position with interpolation
    if (currentIndex >= points.length - 1) {
      return { lon: points[points.length - 1].lon, lat: points[points.length - 1].lat };
    }

    const p1 = points[currentIndex];
    const p2 = points[currentIndex + 1];
    return {
      lon: p1.lon + animationProgress * (p2.lon - p1.lon),
      lat: p1.lat + animationProgress * (p2.lat - p1.lat),
    };
  }, [matchedRoute, routeDistances, showMatchedRoute, totalRouteDistance, currentDistanceTraveled, totalGpsDistance, currentIndex, points, animationProgress]);

  // Create GeoJSON for the traveled portion of the matched route
  const traveledRouteGeoJson = useMemo(() => {
    if (!matchedRoute || !routeDistances || matchedRoute.coordinates.length < 2) return null;

    const routeProgress = currentDistanceTraveled / totalGpsDistance;
    const targetDistance = routeProgress * totalRouteDistance;

    // Collect coordinates up to target distance
    const traveledCoords: [number, number][] = [];
    for (let i = 0; i < routeDistances.length; i++) {
      if (routeDistances[i] <= targetDistance) {
        traveledCoords.push(matchedRoute.coordinates[i]);
      } else {
        // Add interpolated final point
        if (i > 0) {
          const segmentStart = routeDistances[i - 1];
          const segmentEnd = routeDistances[i];
          const t = (targetDistance - segmentStart) / (segmentEnd - segmentStart);
          const [lon1, lat1] = matchedRoute.coordinates[i - 1];
          const [lon2, lat2] = matchedRoute.coordinates[i];
          traveledCoords.push([
            lon1 + t * (lon2 - lon1),
            lat1 + t * (lat2 - lat1),
          ]);
        }
        break;
      }
    }

    if (traveledCoords.length < 2) return null;

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: traveledCoords,
      },
    };
  }, [matchedRoute, routeDistances, currentDistanceTraveled, totalGpsDistance, totalRouteDistance]);

  // Create GeoJSON for the complete trail (fallback when no matched route)
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

  // Auto-trigger map matching when journey loads
  useEffect(() => {
    if (
      points.length >= 2 &&
      !matchedRoute &&
      !isMatching &&
      !hasTriggeredMatch &&
      onMatchRoute
    ) {
      setHasTriggeredMatch(true);
      onMatchRoute();
    }
  }, [points.length, matchedRoute, isMatching, hasTriggeredMatch, onMatchRoute]);

  // Reset trigger flag when journey changes
  useEffect(() => {
    setHasTriggeredMatch(false);
  }, [points]);

  // Animation loop for playback - uses real GPS velocity
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

      // Get current velocity from GPS data (m/s), default to 10 m/s if not available
      const velocity = (points[currentIndex]?.velocity || 10) * playbackSpeed;

      // Calculate distance traveled in this frame (in meters)
      const distanceTraveled = velocity * (elapsed / 1000);

      // Get distance to next point
      const segmentDistance = currentIndex < points.length - 1
        ? gpsDistances[currentIndex + 1] - gpsDistances[currentIndex]
        : 0;

      if (segmentDistance > 0) {
        // Calculate new progress within segment
        const progressIncrement = distanceTraveled / segmentDistance;
        const newProgress = animationProgress + progressIncrement;

        if (newProgress >= 1) {
          // Move to next point
          const nextIndex = currentIndex + 1;
          if (nextIndex >= points.length) {
            setIsPlaying(false);
            setCurrentIndex(points.length - 1);
            setAnimationProgress(0);
          } else {
            setCurrentIndex(nextIndex);
            setAnimationProgress(newProgress - 1);
          }
        } else {
          setAnimationProgress(newProgress);
        }
      } else {
        // At the end or no segment, move to next point
        const nextIndex = currentIndex + 1;
        if (nextIndex >= points.length) {
          setIsPlaying(false);
          setCurrentIndex(points.length - 1);
          setAnimationProgress(0);
        } else {
          setCurrentIndex(nextIndex);
          setAnimationProgress(0);
        }
      }

      lastFrameTimeRef.current = timestamp;
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, playbackSpeed, currentIndex, animationProgress, points, gpsDistances]);

  // Reset playback
  const handleReset = () => {
    setIsPlaying(false);
    setCurrentIndex(0);
    setAnimationProgress(0);
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
    setAnimationProgress(0);
  };

  // Step to previous point
  const handleStepBack = () => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      setCurrentIndex(newIndex);
      setAnimationProgress(0);
      // If popup is open, move it to the new point
      if (selectedPointIndex !== null) {
        setSelectedPointIndex(newIndex);
        // Pan map to new point
        if (mapRef.current) {
          mapRef.current.easeTo({
            center: [points[newIndex].lon, points[newIndex].lat],
            padding: { top: 300, bottom: 50, left: 50, right: 50 },
            duration: 300,
          });
        }
      }
    }
  };

  // Step to next point
  const handleStepForward = () => {
    if (currentIndex < points.length - 1) {
      const newIndex = currentIndex + 1;
      setCurrentIndex(newIndex);
      setAnimationProgress(0);
      // If popup is open, move it to the new point
      if (selectedPointIndex !== null) {
        setSelectedPointIndex(newIndex);
        // Pan map to new point
        if (mapRef.current) {
          mapRef.current.easeTo({
            center: [points[newIndex].lon, points[newIndex].lat],
            padding: { top: 300, bottom: 50, left: 50, right: 50 },
            duration: 300,
          });
        }
      }
    }
  };

  // Format velocity for display (respects distance_unit preference)
  const formatVelocity = (velocity?: number) => {
    if (velocity === undefined) return '--';
    if (preferences.distance_unit === 'mi') {
      // Convert m/s to mph (1 m/s = 2.23694 mph)
      const mph = velocity * 2.23694;
      return `${mph.toFixed(1)} mph`;
    }
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

  // Format distance for display (respects distance_unit preference)
  const formatDistance = (distance?: number) => {
    if (distance === undefined) return '--';
    if (preferences.distance_unit === 'mi') {
      // Convert meters to feet/miles
      const feet = distance * 3.28084;
      if (feet < 5280) {
        return `${feet.toFixed(0)} ft`;
      }
      const miles = distance / 1609.344;
      return `${miles.toFixed(2)} mi`;
    }
    // Metric: meters/kilometers
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

  const hasMatchedRoute = matchedRoute && showMatchedRoute;

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Map */}
      <div className="flex-1 min-h-[300px] relative">
        {/* Loading overlay */}
        {isMatching && (
          <div className="absolute inset-0 bg-background/50 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 bg-background px-4 py-2 rounded-lg shadow-lg">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Snapping to roads...</span>
            </div>
          </div>
        )}

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

          {/* Full matched route (light blue, upcoming path) */}
          {matchedRoute && showMatchedRoute && (
            <Source
              id="matched-route-bg"
              type="geojson"
              data={{
                type: 'Feature',
                properties: {},
                geometry: matchedRoute,
              }}
            >
              <Layer
                id="matched-route-bg-line"
                type="line"
                paint={{
                  'line-color': '#93c5fd',
                  'line-width': 4,
                  'line-opacity': 0.7,
                }}
              />
            </Source>
          )}

          {/* Traveled portion of matched route (solid) */}
          {hasMatchedRoute && traveledRouteGeoJson && (
            <Source id="traveled-route" type="geojson" data={traveledRouteGeoJson}>
              <Layer
                id="traveled-route-line"
                type="line"
                paint={{
                  'line-color': '#0066CC',
                  'line-width': 4,
                  'line-opacity': 0.9,
                }}
              />
            </Source>
          )}

          {/* Fallback: Raw GPS trail (only when no matched route or toggle is off) */}
          {!hasMatchedRoute && completeTrailGeoJson && (
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

          {/* Current position marker - follows matched route */}
          {currentMarkerPosition && (
            <Marker
              longitude={currentMarkerPosition.lon}
              latitude={currentMarkerPosition.lat}
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

          {/* Clickable point markers (only show when not using matched route or for selection) */}
          {!hasMatchedRoute && points.map((point, index) => (
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
                      setAnimationProgress(0);
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

        {/* Point info overlay for snapped view */}
        {hasMatchedRoute && currentPoint && (
          <div className="absolute top-3 right-12 bg-background/95 backdrop-blur-sm rounded-lg shadow-lg border p-3 min-w-[200px] z-10">
            <div className="flex items-center justify-between mb-2 pb-2 border-b">
              <span className="font-semibold text-sm">Current Position</span>
              <Badge variant="outline" className="text-xs">
                {currentIndex + 1} / {points.length}
              </Badge>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <Clock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span>{new Date(currentPoint.time).toLocaleString()}</span>
              </div>

              <div className="flex items-center gap-2">
                <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span>{currentPoint.lat.toFixed(6)}, {currentPoint.lon.toFixed(6)}</span>
              </div>

              <div className="flex items-center gap-2">
                <Gauge className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span className="font-medium">{formatVelocity(currentPoint.velocity)}</span>
              </div>

              <div className="flex items-center gap-2">
                <Navigation className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span>{formatBearing(currentPoint.bearing)}</span>
              </div>

              <div className="flex items-center gap-2">
                <Route className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span>{formatDistance(currentPoint.distance)}</span>
              </div>

              <div className="flex items-center gap-2">
                <Target className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span>{formatDOP(currentPoint.dop)}</span>
              </div>
            </div>
          </div>
        )}
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
          {/* Toggle matched/raw route */}
          {matchedRoute && (
            <Button
              variant={showMatchedRoute ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowMatchedRoute(!showMatchedRoute)}
              title={showMatchedRoute ? 'Show raw GPS' : 'Show snapped route'}
              className="mr-2"
            >
              <Waypoints className="h-4 w-4 mr-1" />
              {showMatchedRoute ? 'Snapped' : 'Raw'}
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={handleReset}
            title="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={handleStepBack}
            disabled={currentIndex === 0}
            title="Previous point"
          >
            <SkipBack className="h-4 w-4" />
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
            size="icon"
            onClick={handleStepForward}
            disabled={currentIndex >= points.length - 1}
            title="Next point"
          >
            <SkipForward className="h-4 w-4" />
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
