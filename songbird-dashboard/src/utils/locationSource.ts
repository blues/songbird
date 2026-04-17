/**
 * Shared location source display helpers
 */

import { Satellite, Radio, MapPin } from 'lucide-react';

export interface LocationSourceInfo {
  label: string;
  icon: typeof MapPin;
  color: string;
  bgColor: string;
}

export function getLocationSourceInfo(source?: string): LocationSourceInfo {
  switch (source) {
    case 'gps':
      return { label: 'GPS', icon: Satellite, color: 'text-green-600', bgColor: 'bg-green-100' };
    case 'cell':
    case 'tower':
      return { label: 'Cell Tower', icon: Radio, color: 'text-blue-600', bgColor: 'bg-blue-100' };
    case 'wifi':
      return { label: 'Wi-Fi', icon: Radio, color: 'text-purple-600', bgColor: 'bg-purple-100' };
    case 'triangulation':
    case 'triangulated':
      return { label: 'Triangulated', icon: Radio, color: 'text-orange-600', bgColor: 'bg-orange-100' };
    default:
      return { label: 'Unknown', icon: MapPin, color: 'text-gray-600', bgColor: 'bg-gray-100' };
  }
}
