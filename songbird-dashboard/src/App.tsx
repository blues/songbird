import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

import { Layout } from '@/components/layout/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { DeviceDetail } from '@/pages/DeviceDetail';
import { initializeApi } from '@/api/client';

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

  return (
    <QueryClientProvider client={queryClient}>
      <Authenticator>
        {({ signOut, user }) => (
          <BrowserRouter>
            <Routes>
              <Route
                element={
                  <Layout
                    user={user ? { username: user.username || '', email: user.signInDetails?.loginId || '' } : undefined}
                    selectedFleet={selectedFleet}
                    fleets={[]}
                    onFleetChange={setSelectedFleet}
                    onSignOut={signOut}
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
                  element={
                    <Dashboard
                      mapboxToken={mapboxToken}
                      selectedFleet={selectedFleet}
                    />
                  }
                />
                <Route
                  path="/devices/:deviceUid"
                  element={<DeviceDetail mapboxToken={mapboxToken} />}
                />
                <Route
                  path="/map"
                  element={
                    <Dashboard
                      mapboxToken={mapboxToken}
                      selectedFleet={selectedFleet}
                    />
                  }
                />
                <Route
                  path="/alerts"
                  element={
                    <div className="text-center py-12 text-muted-foreground">
                      Alerts page coming soon
                    </div>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <div className="text-center py-12 text-muted-foreground">
                      Settings page coming soon
                    </div>
                  }
                />
              </Route>
            </Routes>
          </BrowserRouter>
        )}
      </Authenticator>
    </QueryClientProvider>
  );
}

export default App;
