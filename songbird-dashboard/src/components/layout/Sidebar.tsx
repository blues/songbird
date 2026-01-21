import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Cpu,
  AlertTriangle,
  Settings,
  Map,
  Terminal,
  Sparkles,
  Radio,
} from 'lucide-react';
import { useFeatureFlags, type FeatureFlagKey } from '@/hooks/useFeatureFlags';
import { useMyDevice } from '@/hooks/useMyDevice';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  featureFlag?: FeatureFlagKey;
}

const navItems: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices', icon: Cpu, label: 'Devices' },
  { to: '/map', icon: Map, label: 'Fleet Map' },
  { to: '/alerts', icon: AlertTriangle, label: 'Alerts' },
  { to: '/commands', icon: Terminal, label: 'Commands' },
  { to: '/analytics', icon: Sparkles, label: 'Analytics', featureFlag: 'analytics' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const flags = useFeatureFlags();
  const { serialNumber: myDeviceSerial } = useMyDevice();

  const visibleNavItems = useMemo(() => {
    return navItems.filter(item => {
      if (!item.featureFlag) return true;
      return flags[item.featureFlag];
    });
  }, [flags]);

  const myDevicePath = myDeviceSerial ? `/devices/${myDeviceSerial}` : null;

  return (
    <aside className="hidden md:flex w-64 flex-col border-r bg-muted/40">
      <nav className="flex-1 space-y-1 p-4">
        {visibleNavItems.map((item, index) => (
          <>
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/devices' && !!myDevicePath}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
            {index === 0 && myDevicePath && (
              <NavLink
                key="my-device"
                to={myDevicePath}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )
                }
              >
                <Radio className="h-5 w-5" />
                My Device
              </NavLink>
            )}
          </>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t p-4">
        <div className="text-xs text-muted-foreground">
          <div className="font-medium">Songbird v1.0.0</div>
          <div>Blues Inc. Tracker Demo</div>
        </div>
      </div>
    </aside>
  );
}
