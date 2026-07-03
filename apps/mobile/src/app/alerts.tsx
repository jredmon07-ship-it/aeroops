/**
 * src/app/alerts.tsx — In-app alerts screen.
 *
 * READ-ONLY: renders GET /api/mobile/v1/alerts (self-scoped derived alerts:
 * upcoming reservations ≤24h + grounded aircraft on an upcoming reservation).
 * No writes — matches the [VERIFY-4M-SEC-1] read-only token posture.
 *
 * States rendered: loading / empty / populated / error / offline / 401.
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
import { fetchAlerts, AuthError, NetworkError } from '../lib/api';
import { AlertCard } from '../components/AlertCard';
import { BottomNav } from '../components/BottomNav';
import type { MobileAlertDTO } from '@aeroops/core';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; alerts: MobileAlertDTO[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'offline' };

export default function AlertsScreen(): React.ReactElement {
  const router = useRouter();
  const { token, signOut } = useAuth();

  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false): Promise<void> => {
      if (!token) return;

      if (!isRefresh) {
        setState({ kind: 'loading' });
      }

      try {
        const result = await fetchAlerts(token);
        if (result.alerts.length === 0) {
          setState({ kind: 'empty' });
        } else {
          setState({ kind: 'success', alerts: result.alerts });
        }
      } catch (err) {
        if (err instanceof AuthError) {
          await signOut();
          router.replace('/login');
          return;
        }
        if (err instanceof NetworkError) {
          setState({ kind: 'offline' });
          return;
        }
        setState({ kind: 'error', message: 'Failed to load alerts. Please try again.' });
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

  function renderContent(): React.ReactElement {
    if (state.kind === 'loading') {
      return (
        <View style={styles.centered} accessible accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color="#1d4ed8" />
          <Text style={styles.loadingText}>Loading alerts...</Text>
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
          <Text style={styles.iconText}>No Alerts</Text>
          <Text style={styles.stateMessage}>
            You are all caught up.{'\n'}
            Pull down to refresh.
          </Text>
        </View>
      );
    }

    if (state.kind === 'success') {
      return (
        <FlatList
          data={state.alerts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <AlertCard alert={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#1d4ed8" />
          }
          ListHeaderComponent={<Text style={styles.windowLabel}>Your alerts — read only</Text>}
        />
      );
    }

    return <View />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>{renderContent()}</View>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  content: {
    flex: 1,
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
