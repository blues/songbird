import { useState, useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  LayoutDashboard,
  Cpu,
  AlertTriangle,
  Settings,
  Map,
  Terminal,
  Sparkles,
} from 'lucide-react';
import { useFeatureFlags, type FeatureFlags } from '@/contexts/FeatureFlagsContext';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  featureFlag?: keyof FeatureFlags;
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

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const { flags } = useFeatureFlags();

  const visibleNavItems = useMemo(() => {
    return navItems.filter(item => {
      if (!item.featureFlag) return true;
      return flags[item.featureFlag];
    });
  }, [flags]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
        <span className="sr-only">Toggle menu</span>
      </Button>
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2">
            <img src="/songbird-logo.svg" alt="Songbird" className="h-6 w-6" />
            Songbird
          </SheetTitle>
        </SheetHeader>
        <nav className="flex-1 space-y-1 p-4">
          {visibleNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
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
          ))}
        </nav>
        <div className="border-t p-4">
          <div className="text-xs text-muted-foreground">
            <div className="font-medium">Songbird v1.0.0</div>
            <div>Blues Inc. Tracker Demo</div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
