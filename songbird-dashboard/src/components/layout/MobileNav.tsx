import { useState, useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { NAV_ITEMS, navLinkClass } from '@/config/navigation';

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const flags = useFeatureFlags();

  const visibleNavItems = useMemo(() => {
    return NAV_ITEMS.filter(item => {
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
              className={({ isActive }) => navLinkClass(isActive)}
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
