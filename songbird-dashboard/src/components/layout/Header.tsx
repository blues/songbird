import { Link } from 'react-router-dom';
import { Bell, User, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface HeaderProps {
  user?: { username: string; email: string };
  alertCount?: number;
  selectedFleet?: string;
  fleets?: Array<{ fleet_uid: string; name: string }>;
  onFleetChange?: (fleetUid: string) => void;
  onSignOut?: () => void;
}

export function Header({
  user,
  alertCount = 0,
  selectedFleet,
  fleets = [],
  onFleetChange,
  onSignOut,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-4">
          <span className="text-2xl">🐦</span>
          <span className="font-bold text-lg hidden sm:inline-block">
            Songbird Dashboard
          </span>
        </div>

        {/* Fleet Selector */}
        {fleets.length > 0 && (
          <Select value={selectedFleet || 'all'} onValueChange={onFleetChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select Fleet" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Fleets</SelectItem>
              {fleets.map((fleet) => (
                <SelectItem key={fleet.fleet_uid} value={fleet.fleet_uid}>
                  {fleet.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex-1" />

        {/* Right side items */}
        <div className="flex items-center gap-2">
          {/* Alerts */}
          <Link to="/alerts">
            <Button variant="ghost" size="icon" className="relative">
              <Bell className={`h-5 w-5 ${alertCount > 0 ? 'text-destructive' : ''}`} />
              {alertCount > 0 && (
                <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center animate-pulse">
                  {alertCount > 9 ? '9+' : alertCount}
                </span>
              )}
            </Button>
          </Link>

          {/* User */}
          {user && (
            <div className="flex items-center gap-2 ml-2">
              <div className="hidden md:flex flex-col items-end">
                <span className="text-sm font-medium">{user.username}</span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </div>
              <Button variant="ghost" size="icon">
                <User className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={onSignOut}>
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
