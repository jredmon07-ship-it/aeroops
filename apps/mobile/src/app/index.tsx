/**
 * src/app/index.tsx — Schedule screen (authenticated home route).
 *
 * READ-ONLY: renders reservations from GET /api/mobile/v1/schedule.
 * No writes (dispatch, booking, etc.) — matches the [VERIFY-4M-SEC-1] read-only
 * token posture. Write surfaces require the instant-revocation predecessor.
 *
 * States rendered:
 *   - Loading: spinner while fetching
 *   - Empty: no reservations in the window
 *   - Populated: list of ReservationCard components
 *   - Error / offline: error message with retry
 *   - 401: clears token and redirects to login (token expired/revoked)
 *
 * Token lifecycle:
 *   - Token from AuthContext (sourced from expo-secure-store).
 *   - 401 response → signOut() → root layout redirects to login.
 *   - Token is NEVER logged.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../contexts/AuthContext';
import { fetchSchedule, weekWindow, AuthError, NetworkError } from '../lib/api';
import { ReservationCard } from '../components/ReservationCard';
import type { MobileReservationDTO, MobileResourceDTO } from '@aeroops/core';

// ─── Types ────────────────────────────────────────────────────────────────────

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; reservations: MobileReservationDTO[]; resources: MobileResourceDTO[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'offline' };

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ScheduleScreen(): React.ReactElement {
  const router = useRouter();
  const { token, userInfo, signOut } = useAuth();

  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false): Promise<void> => {
      if (!token) {
        // No token — root layout will redirect; nothing to do here.
        return;
      }

      if (!isRefresh) {
        setState({ kind: 'loading' });
      }

      const { from, to } = weekWindow();

      try {
        const result = await fetchSchedule(token, from, to);
        if (result.reservations.length === 0) {
          setState({ kind: 'empty' });
        } else {
          setState({
            kind: 'success',
            reservations: result.reservations,
            resources: result.resources,
          });
        }
      } catch (err) {
        if (err instanceof AuthError) {
          // Token expired or revoked — clear it and redirect to login.
          await signOut();
          router.replace('/login');
          return;
        }
        if (err instanceof NetworkError) {
          setState({ kind: 'offline' });
          return;
        }
        setState({
          kind: 'error',
          message: 'Failed to load schedule. Please try again.',
        });
      } finally {
        if (isRefresh) {
          setRefreshing(false);
        }
      }
    },
    [token, signOut, router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    router.replace('/login');
  }, [signOut, router]);

  // ─── Render states ──────────────────────────────────────────────────────────

  function renderContent(): React.ReactElement {
    if (state.kind === 'loading') {
      return (
        <View style={styles.centered} accessible accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color="#1d4ed8" />
          <Text style={styles.loadingText}>Loading schedule...</Text>
        </View>
      );
    }

    if (state.kind === 'offline') {
      return (
        <View style={styles.centered} accessible accessibilityLiveRegion="polite">
          <Text style={styles.iconText}>No Connection</Text>
          <Text style={styles.stateMessage}>
            You appear to be offline. Check your connection and pull down to refresh.
          </Text>
          <Pressable style={styles.retryButton} onPress={() => void load()} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
    }

    if (state.kind === 'error') {
      return (
        <View style={styles.centered} accessible accessibilityLiveRegion="polite">
          <Text style={styles.iconText}>Error</Text>
          <Text style={styles.stateMessage}>{state.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void load()} accessibilityRole="button">
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      );
    }

    if (state.kind === 'empty') {
      return (
        <View style={styles.centered} accessible>
          <Text style={styles.iconText}>No Flights</Text>
          <Text style={styles.stateMessage}>
            No reservations found for the next 7 days.{'\n'}
            Pull down to refresh.
          </Text>
        </View>
      );
    }

    if (state.kind === 'success') {
      // Filter out cancelled reservations for a cleaner view, show them dimmed.
      const sorted = [...state.reservations].sort(
        (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
      );

      return (
        <FlatList
          data={sorted}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ReservationCard reservation={item} resources={state.resources} />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#1d4ed8" />
          }
          ListHeaderComponent={
            <Text style={styles.windowLabel}>Next 7 days — read only</Text>
          }
        />
      );
    }

    // idle — nothing yet
    return <View />;
  }

  return (
    <View style={styles.container}>
      {/* Header row with org name and sign-out */}
      <View style={styles.topBar}>
        <View>
          {userInfo ? (
            <>
              <Text style={styles.orgName}>{userInfo.orgName}</Text>
              <Text style={styles.userEmail}>{userInfo.email}</Text>
            </>
          ) : null}
        </View>
        <Pressable
          style={styles.signOutButton}
          onPress={() => void handleSignOut()}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>

      {/* Main content */}
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  orgName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  userEmail: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  signOutButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  signOutText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 8,
  },
  windowLabel: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    marginVertical: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  iconText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#334155',
  },
  loadingText: {
    marginTop: 12,
    color: '#64748b',
    fontSize: 15,
  },
  stateMessage: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 22,
  },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#1d4ed8',
    borderRadius: 10,
  },
  retryText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15,
  },
});
