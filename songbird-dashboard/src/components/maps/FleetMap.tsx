import { useEffect, useRef, useState } from 'react';
import Map, { Marker, Popup, NavigationControl } from 'react-map-gl';
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
  const mapRef = useRef(null);
  const [popupDevice, setPopupDevice] = useState<Device | null>(null);

  // Filter devices with location
  const devicesWithLocation = devices.filter(
    (d) => d.latitude != null && d.longitude != null
  );

  // Calculate center based on devices
  const center = devicesWithLocation.length > 0
    ? {
        longitude:
          devicesWithLocation.reduce((sum, d) => sum + (d.longitude || 0), 0) /
          devicesWithLocation.length,
        latitude:
          devicesWithLocation.reduce((sum, d) => sum + (d.latitude || 0), 0) /
          devicesWithLocation.length,
      }
    : { longitude: -97.7431, latitude: 30.2672 }; // Austin, TX default

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

  return (
    <div className={className}>
      <Map
        ref={mapRef}
        initialViewState={{
          ...center,
          zoom: 10,
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
