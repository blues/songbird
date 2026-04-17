/**
 * Shared navigation configuration
 */

import {
  LayoutDashboard,
  Cpu,
  AlertTriangle,
  Settings,
  Map,
  Terminal,
  Sparkles,
} from 'lucide-react';
import type { FeatureFlagKey } from '@/hooks/useFeatureFlags';

export interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  featureFlag?: FeatureFlagKey;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices', icon: Cpu, label: 'Devices' },
  { to: '/map', icon: Map, label: 'Fleet Map' },
  { to: '/alerts', icon: AlertTriangle, label: 'Alerts' },
  { to: '/commands', icon: Terminal, label: 'Commands' },
  { to: '/analytics', icon: Sparkles, label: 'Analytics', featureFlag: 'analytics' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function navLinkClass(isActive: boolean): string {
  return [
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  ].join(' ');
}
