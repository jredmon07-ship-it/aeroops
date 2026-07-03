/**
 * src/app/fleet/[id].tsx — Aircraft detail screen.
 *
 * READ-ONLY: renders GET /api/mobile/v1/fleet/[id].
 * No writes (grounding, squawk reporting/resolving, edits) — matches the
 * [VERIFY-4M-SEC-1] read-only token posture.
 *
 * States rendered: loading / not-found (empty) / populated / error / offline / 401.
 *
 * [VERIFY-5-A] currentHobbs/currentTach are labeled "last recorded" — NOT an
 * authoritative airframe total or maintenance value.
 * [VERIFY-5-B] grounding is operator data, never "not airworthy" language.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { fetchAircraftDetail, AuthError, NetworkError } from '../../lib/api';
import type { MobileAircraftDetailDTO } from '@aeroops/core';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; aircraft: MobileAircraftDetailDTO }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'offline' };

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default function AircraftDetailScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { token, signOut } = useAuth();

  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false): Promise<void> => {
      if (!token || !id) return;

      if (!isRefresh) {
        setState({ kind: 'loading' });
      }

      try {
        const aircraft = await fetchAircraftDetail(token, id);
        if (!aircraft) {
          setState({ kind: 'not_found' });
        } else {
          setState({ kind: 'success', aircraft });
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
        setState({ kind: 'error', message: 'Failed to load aircraft. Please try again.' });
      } finally {
        if (isRefresh) {
          setRefreshing(false);
        }
      }
    },
    [token, id, signOut, router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <View style={styles.centered} accessible accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color="#1d4ed8" />
        <Text style={styles.loadingText}>Loading aircraft...</Text>
      </View>
    );
  }

  if (state.kind === 'offline') {
    return (
      <View style={styles.centered} accessible accessibilityLiveRegion="polite">
        <Text style={styles.iconText}>No Connection</Text>
        <Text style={styles.stateMessage}>
          You appear to be offline. Check your connection and try again.
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

  if (state.kind === 'not_found') {
    return (
      <View style={styles.centered} accessible>
        <Text style={styles.iconText}>Not Found</Text>
        <Text style={styles.stateMessage}>
          This aircraft is not available in your organization.
        </Text>
      </View>
    );
  }

  const { aircraft } = state;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#1d4ed8" />
      }
    >
      {/* Identity */}
      <View style={styles.headerCard}>
        <Text style={styles.tail}>{aircraft.tailNumber}</Text>
        <Text style={styles.subtitle}>
          {[aircraft.make, aircraft.model].filter(Boolean).join(' ') || 'No make/model on file'}
        </Text>
        {!aircraft.active ? <Text style={styles.inactiveNote}>Inactive aircraft</Text> : null}
      </View>

      {/* Grounding — operator data, not an airworthiness determination */}
      <View style={[styles.card, aircraft.grounded && styles.cardGrounded]}>
        <Text style={styles.cardTitle}>Status</Text>
        {aircraft.grounded ? (
          <>
            <Text style={styles.groundedText}>Grounded</Text>
            <Text style={styles.cardBody}>
              {aircraft.groundingReason ?? 'No reason given'}
            </Text>
            {aircraft.groundingSince ? (
              <Text style={styles.cardMeta}>Since {formatDateTime(aircraft.groundingSince)}</Text>
            ) : null}
            <Text style={styles.disclaimer}>
              Operator-entered status — not an FAA airworthiness determination.
            </Text>
          </>
        ) : (
          <Text style={styles.cardBody}>Not grounded</Text>
        )}
      </View>

      {/* Meters — display-only, last recorded */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Meters (last recorded)</Text>
        <Text style={styles.cardBody}>
          Hobbs: {aircraft.hasHobbs ? (aircraft.currentHobbs ?? '—') : 'Not tracked'}
        </Text>
        <Text style={styles.cardBody}>
          Tach: {aircraft.hasTach ? (aircraft.currentTach ?? '—') : 'Not tracked'}
        </Text>
        {aircraft.currentMetersAsOf ? (
          <Text style={styles.cardMeta}>As of {formatDateTime(aircraft.currentMetersAsOf)}</Text>
        ) : null}
      </View>

      {/* Open squawks */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Open Squawks ({aircraft.openSquawkCount})</Text>
        {aircraft.recentSquawks.length === 0 ? (
          <Text style={styles.cardBody}>No open squawks.</Text>
        ) : (
          aircraft.recentSquawks
            .filter((s) => s.status === 'open')
            .map((squawk) => (
              <View key={squawk.id} style={styles.squawkRow}>
                <Text style={styles.squawkTitle}>{squawk.title}</Text>
                <Text style={styles.cardMeta}>
                  {squawk.severity} · {formatDateTime(squawk.reportedAt)}
                </Text>
              </View>
            ))
        )}
      </View>

      {/* Upcoming reservations */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Upcoming Reservations</Text>
        {aircraft.upcomingReservations.length === 0 ? (
          <Text style={styles.cardBody}>No upcoming reservations.</Text>
        ) : (
          aircraft.upcomingReservations.map((r) => (
            <Text key={r.id} style={styles.cardBody}>
              {formatDateTime(r.startAt)} – {formatDateTime(r.endAt)}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
    backgroundColor: '#f8fafc',
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
  headerCard: {
    marginBottom: 16,
  },
  tail: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 15,
    color: '#64748b',
    marginTop: 2,
  },
  inactiveNote: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 4,
    fontStyle: 'italic',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardGrounded: {
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  cardBody: {
    fontSize: 15,
    color: '#0f172a',
    marginBottom: 2,
  },
  cardMeta: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2,
  },
  groundedText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#dc2626',
    marginBottom: 4,
  },
  disclaimer: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 8,
    fontStyle: 'italic',
  },
  squawkRow: {
    marginBottom: 8,
  },
  squawkTitle: {
    fontSize: 14,
    color: '#0f172a',
  },
});
