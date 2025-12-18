import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Map, { Marker, Popup, NavigationControl } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import { MapPin } from 'lucide-react';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { formatTemperature, formatRelativeTime } from '@/utils/formatters';
import type { Device } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

interface FleetMapProps {
  devices: Device[];
  mapboxToken: string;
  selectedDeviceId?: string;
  onDeviceSelect?: (deviceUid: string) => void;
  className?: string;
}

export function FleetMap({
  devices,
  mapboxToken,
  selectedDeviceId,
  onDeviceSelect,
  className,
}: FleetMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [popupDevice, setPopupDevice] = useState<Device | null>(null);
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

  // Highlight selected device
  useEffect(() => {
    if (selectedDeviceId) {
      const device = devicesWithLocation.find(
        (d) => d.device_uid === selectedDeviceId
      );
      if (device) {
        setPopupDevice(device);
      }
    }
  }, [selectedDeviceId, devicesWithLocation]);

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
        mapStyle="mapbox://styles/mapbox/light-v11"
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
              setPopupDevice(device);
              onDeviceSelect?.(device.device_uid);
            }}
          >
            <div
              className={`cursor-pointer transition-transform hover:scale-110 ${
                device.device_uid === selectedDeviceId ? 'scale-125' : ''
              }`}
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

        {popupDevice && popupDevice.latitude && popupDevice.longitude && (
          <Popup
            longitude={popupDevice.longitude}
            latitude={popupDevice.latitude}
            anchor="top"
            onClose={() => setPopupDevice(null)}
            closeButton={true}
            closeOnClick={false}
          >
            <div className="p-2 min-w-[200px]">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold">
                  {popupDevice.name || popupDevice.serial_number}
                </h4>
                <DeviceStatus status={popupDevice.status} showLabel={false} />
              </div>

              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Temperature:</span>
                  <span>{formatTemperature(popupDevice.temperature)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mode:</span>
                  <span className="capitalize">{popupDevice.mode}</span>
                </div>
                {popupDevice.last_seen && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last seen:</span>
                    <span>{formatRelativeTime(popupDevice.last_seen)}</span>
                  </div>
                )}
              </div>

              <button
                className="mt-3 w-full text-sm text-primary hover:underline"
                onClick={() => onDeviceSelect?.(popupDevice.device_uid)}
              >
                View Details →
              </button>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}
