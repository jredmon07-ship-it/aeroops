/**
 * src/app/_layout.tsx — Root layout for the AeroOps mobile app (expo-router).
 *
 * Responsibilities:
 *   1. Wraps the entire app in AuthProvider (token loaded from keychain).
 *   2. Guards navigation: when auth is resolved (isLoading=false) and there is
 *      no token, expo-router's <Redirect> sends the user to the login screen.
 *      When authenticated, the schedule screen is the home route.
 *
 * SECURITY: The auth gate here is UI-only convenience; the actual auth
 * enforcement happens server-side (verifyMobileToken in the route handler).
 * A stale/expired token stored in the keychain will result in a 401 on the
 * first API call, which triggers signOut() → returns here → login screen.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, Redirect } from 'expo-router';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { StatusBar } from 'expo-status-bar';

function RootNavigator(): React.ReactElement {
  const { token, isLoading } = useAuth();

  if (isLoading) {
    // Splash / loading state while keychain read is in progress.
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#1d4ed8" />
      </View>
    );
  }

  if (!token) {
    // No token in keychain → redirect to login.
    return <Redirect href="/login" />;
  }

  // Authenticated → the index route (schedule) is the home.
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1d4ed8' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: 'bold' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Schedule' }} />
      <Stack.Screen
        name="login"
        options={{ title: 'Sign In', headerShown: false }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
});

export default function RootLayout(): React.ReactElement {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </AuthProvider>
  );
}
