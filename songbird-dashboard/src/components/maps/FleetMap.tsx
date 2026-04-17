import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Map, { Marker, Popup, NavigationControl } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin } from 'lucide-react';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { formatRelativeTime } from '@/utils/formatters';
import { getLocationSourceInfo } from '@/utils/locationSource';
import { MAP_STYLES, DEFAULT_MAP_CENTER } from '@/config/mapConfig';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { Device } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

interface FleetMapProps {
  devices: Device[];
  mapboxToken: string;
  selectedDeviceId?: string;
  onDeviceSelect?: (serialNumber: string) => void;
  className?: string;
}

export function FleetMap({
  devices,
  mapboxToken,
  selectedDeviceId,
  onDeviceSelect,
  className,
}: FleetMapProps) {
  const { preferences } = usePreferences();
  const mapStyle = MAP_STYLES[preferences.map_style] || MAP_STYLES.street;

  const mapRef = useRef<MapRef>(null);
  const [hoveredDevice, setHoveredDevice] = useState<Device | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Filter devices with location
  const devicesWithLocation = useMemo(() =>
    devices.filter((d) => d.latitude != null && d.longitude != null),
    [devices]
  );

  // Calculate bounds to fit all devices
  const bounds = useMemo(() => {
    if (devicesWithLocation.length === 0) return null;

    const lats = devicesWithLocation.map((d) => d.latitude!);
    const lons = devicesWithLocation.map((d) => d.longitude!);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [devicesWithLocation]);

  // Fit map to bounds when devices load
  const fitMapToBounds = useCallback(() => {
    if (!mapRef.current || !bounds) return;

    const padding = 50;

    // For single device, just center on it with good zoom
    if (devicesWithLocation.length === 1) {
      mapRef.current.flyTo({
        center: [devicesWithLocation[0].longitude!, devicesWithLocation[0].latitude!],
        zoom: 12,
        duration: 1000,
      });
    } else {
      // For multiple devices, fit bounds
      mapRef.current.fitBounds(
        [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
        { padding, duration: 1000, maxZoom: 14 }
      );
    }
  }, [bounds, devicesWithLocation]);

  // Fit bounds when devices first load
  useEffect(() => {
    if (devicesWithLocation.length > 0 && !hasInitialized) {
      // Small delay to ensure map is ready
      const timer = setTimeout(() => {
        fitMapToBounds();
        setHasInitialized(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [devicesWithLocation, hasInitialized, fitMapToBounds]);

  // No longer auto-show popup for selected device - hover handles it

  return (
    <div className={className}>
      <Map
        ref={mapRef}
        initialViewState={{
          ...DEFAULT_MAP_CENTER,
          zoom: 4,
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={mapStyle}
        mapboxAccessToken={mapboxToken}
      >
        <NavigationControl position="top-right" />

        {devicesWithLocation.map((device) => (
          <Marker
            key={device.device_uid}
            longitude={device.longitude!}
            latitude={device.latitude!}
            anchor="bottom"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              onDeviceSelect?.(device.serial_number);
            }}
          >
            <div
              className={`cursor-pointer transition-transform hover:scale-110 ${
                device.device_uid === selectedDeviceId ? 'scale-125' : ''
              }`}
              onMouseEnter={() => setHoveredDevice(device)}
              onMouseLeave={() => setHoveredDevice(null)}
            >
              <MapPin
                className={`h-8 w-8 ${
                  device.status === 'online'
                    ? 'text-green-500'
                    : device.status === 'offline'
                    ? 'text-red-500'
                    : 'text-gray-400'
                }`}
                fill="currentColor"
                strokeWidth={1.5}
                stroke="white"
              />
            </div>
          </Marker>
        ))}

        {hoveredDevice && hoveredDevice.latitude && hoveredDevice.longitude && (
          <Popup
            longitude={hoveredDevice.longitude}
            latitude={hoveredDevice.latitude}
            anchor="top"
            closeButton={false}
            closeOnClick={false}
          >
            <div className="p-2 min-w-[200px]">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-sm">
                  {hoveredDevice.name || hoveredDevice.serial_number}
                </h4>
                <DeviceStatus status={hoveredDevice.status} showLabel={false} />
              </div>

              {/* Location Details */}
              <div className="space-y-1">
                <div className="text-sm">
                  {hoveredDevice.location_name || `${hoveredDevice.latitude.toFixed(4)}, ${hoveredDevice.longitude.toFixed(4)}`}
                </div>
                {(() => {
                  const sourceInfo = getLocationSourceInfo(hoveredDevice.location_source);
                  const SourceIcon = sourceInfo.icon;
                  return (
                    <div className={`flex items-center gap-1.5 ${sourceInfo.color}`}>
                      <SourceIcon className="h-3.5 w-3.5" />
                      <span className="text-xs">{sourceInfo.label}</span>
                    </div>
                  );
                })()}
                {hoveredDevice.location_time && (
                  <div className="text-xs text-muted-foreground">
                    Updated {formatRelativeTime(hoveredDevice.location_time)}
                  </div>
                )}
              </div>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}
