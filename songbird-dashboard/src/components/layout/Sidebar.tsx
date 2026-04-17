import { useMemo, Fragment } from 'react';
import { NavLink } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { useMyDevice } from '@/hooks/useMyDevice';
import { NAV_ITEMS, navLinkClass } from '@/config/navigation';

export function Sidebar() {
  const flags = useFeatureFlags();
  const { serialNumber: myDeviceSerial } = useMyDevice();

  const visibleNavItems = useMemo(() => {
    return NAV_ITEMS.filter(item => {
      if (!item.featureFlag) return true;
      return flags[item.featureFlag];
    });
  }, [flags]);

  const myDevicePath = myDeviceSerial ? `/devices/${myDeviceSerial}` : null;

  return (
    <aside className="hidden md:flex w-64 flex-col border-r bg-muted/40">
      <nav className="flex-1 space-y-1 p-4">
        {visibleNavItems.map((item, index) => (
          <Fragment key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/devices' && !!myDevicePath}
              className={({ isActive }) => navLinkClass(isActive)}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
            {index === 0 && myDevicePath && (
              <NavLink
                to={myDevicePath}
                className={({ isActive }) => navLinkClass(isActive)}
              >
                <Radio className="h-5 w-5" />
                My Device
              </NavLink>
            )}
          </Fragment>
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
