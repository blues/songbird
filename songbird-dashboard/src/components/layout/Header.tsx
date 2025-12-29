import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, User, LogOut, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProfileDialog } from '@/components/profile/ProfileDialog';
import { useUserProfile } from '@/hooks/useUserProfile';

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
  const [profileOpen, setProfileOpen] = useState(false);
  const { data: profile } = useUserProfile();

  // Use display name from profile if set, otherwise fall back to username
  const displayName = profile?.name || user?.username || '';

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity">
          <img src="/songbird-logo.svg" alt="Songbird" className="h-8 w-8" />
          <span className="font-bold text-lg hidden sm:inline-block">
            Songbird
          </span>
        </Link>

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

          {/* User Menu */}
          {user && (
            <div className="flex items-center gap-2 ml-2">
              <div className="hidden md:flex flex-col items-end">
                <span className="text-sm font-medium">{displayName}</span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <User className="h-5 w-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span>{displayName}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {user.email}
                      </span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setProfileOpen(true)}>
                    <Settings className="mr-2 h-4 w-4" />
                    Edit Profile
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onSignOut}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </header>
  );
}
