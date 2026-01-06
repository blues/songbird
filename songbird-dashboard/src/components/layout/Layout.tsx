import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface LayoutProps {
  user?: { username: string; email: string };
  alertCount?: number;
  selectedFleet?: string;
  fleets?: Array<{ fleet_uid: string; name: string }>;
  onFleetChange?: (fleetUid: string) => void;
  onSignOut?: () => void;
}

export function Layout({
  user,
  alertCount,
  selectedFleet,
  fleets,
  onFleetChange,
  onSignOut,
}: LayoutProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header
        user={user}
        alertCount={alertCount}
        selectedFleet={selectedFleet}
        fleets={fleets}
        onFleetChange={onFleetChange}
        onSignOut={onSignOut}
      />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
