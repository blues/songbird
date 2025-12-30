import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import type { AuthenticatorProps } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

import { Layout } from '@/components/layout/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { Devices } from '@/pages/Devices';
import { DeviceDetail } from '@/pages/DeviceDetail';
import { Map } from '@/pages/Map';
import { Alerts } from '@/pages/Alerts';
import { Commands } from '@/pages/Commands';
import { Settings } from '@/pages/Settings';
import { PreferencesProvider } from '@/contexts/PreferencesContext';
import { initializeApi } from '@/api/client';
import { useActiveAlerts } from '@/hooks/useAlerts';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  mapboxToken?: string;
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selectedFleet, setSelectedFleet] = useState<string>('all');

  // Load config on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const response = await fetch('/config.json');
        if (!response.ok) {
          throw new Error('Failed to load config');
        }
        const cfg: AppConfig = await response.json();

        // Initialize API
        initializeApi(cfg.apiUrl);

        // Configure Amplify
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: cfg.userPoolId,
              userPoolClientId: cfg.userPoolClientId,
            },
          },
        });

        setConfig(cfg);
      } catch (err) {
        console.error('Config load error:', err);
        setConfigError('Failed to load application configuration');
      }
    }

    loadConfig();
  }, []);

  if (configError) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-500 mb-2">Configuration Error</h1>
          <p className="text-muted-foreground">{configError}</p>
          <p className="text-sm mt-4">
            Make sure config.json exists in the public directory.
          </p>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">🐦</div>
          <p className="text-muted-foreground">Loading Songbird Dashboard...</p>
        </div>
      </div>
    );
  }

  const mapboxToken = config.mapboxToken || import.meta.env.VITE_MAPBOX_TOKEN || '';

  // Custom Authenticator components for branding
  const authenticatorComponents: AuthenticatorProps['components'] = {
    Header() {
      return (
        <div className="flex flex-col items-center pt-8 pb-4">
          <img src="/songbird-logo.svg" alt="Songbird" className="h-16 w-16 mb-3" />
          <h1 className="text-2xl font-bold text-foreground">Songbird</h1>
          <p className="text-sm text-muted-foreground">Fleet Management Dashboard</p>
        </div>
      );
    },
    Footer() {
      return (
        <div className="text-center py-4 text-xs text-muted-foreground">
          Powered by Blues Inc.
        </div>
      );
    },
  };

  // Custom form fields for sign-up and sign-in
  const authenticatorFormFields: AuthenticatorProps['formFields'] = {
    signIn: {
      username: {
        label: 'Username (email)',
        placeholder: 'Enter your email',
      },
    },
    signUp: {
      username: {
        label: 'Username (email)',
        placeholder: 'Enter your email',
        order: 1,
      },
      name: {
        label: 'Full Name',
        placeholder: 'Enter your full name',
        order: 2,
        isRequired: true,
      },
      password: {
        order: 3,
      },
      confirm_password: {
        order: 4,
      },
    },
  };

  // Wrapper component to use hooks inside QueryClientProvider
  function AppLayout({
    user,
    signOut,
  }: {
    user?: { username: string; email: string };
    signOut?: () => void;
  }) {
    const { data: alertsData } = useActiveAlerts();
    const alertCount = alertsData?.active_count || 0;

    return (
      <Layout
        user={user}
        alertCount={alertCount}
        selectedFleet={selectedFleet}
        fleets={[]}
        onFleetChange={setSelectedFleet}
        onSignOut={signOut}
      />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Authenticator components={authenticatorComponents} formFields={authenticatorFormFields}>
        {({ signOut, user }) => (
          <PreferencesProvider>
            <BrowserRouter>
              <Routes>
              <Route
                element={
                  <AppLayout
                    user={user ? { username: user.username || '', email: user.signInDetails?.loginId || '' } : undefined}
                    signOut={signOut}
                  />
                }
              >
                <Route
                  index
                  element={
                    <Dashboard
                      mapboxToken={mapboxToken}
                      selectedFleet={selectedFleet}
                    />
                  }
                />
                <Route
                  path="/devices"
                  element={<Devices />}
                />
                <Route
                  path="/devices/:serialNumber"
                  element={<DeviceDetail mapboxToken={mapboxToken} />}
                />
                <Route
                  path="/map"
                  element={
                    <Map
                      mapboxToken={mapboxToken}
                      selectedFleet={selectedFleet}
                    />
                  }
                />
                <Route
                  path="/alerts"
                  element={<Alerts />}
                />
                <Route
                  path="/commands"
                  element={<Commands />}
                />
                <Route
                  path="/settings"
                  element={<Settings />}
                />
              </Route>
              </Routes>
            </BrowserRouter>
          </PreferencesProvider>
        )}
      </Authenticator>
    </QueryClientProvider>
  );
}

export default App;
