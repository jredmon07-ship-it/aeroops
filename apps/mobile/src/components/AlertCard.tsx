/**
 * components/AlertCard.tsx — Card for a single row in the alerts list.
 *
 * READ-ONLY: renders MobileAlertDTO. `path` is display-only copy here (a web
 * route hint) — deep-linking beyond login/schedule is out of scope for this
 * slice (see README "Scope — what is NOT here").
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MobileAlertDTO } from '@aeroops/core';

interface Props {
  alert: MobileAlertDTO;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function AlertCard({ alert }: Props): React.ReactElement {
  const isGrounded = alert.kind === 'aircraft_grounded';

  return (
    <View
      style={[styles.card, isGrounded && styles.cardGrounded]}
      accessible
      accessibilityRole="none"
      accessibilityLabel={`${alert.title}: ${alert.detail}, ${formatDateTime(alert.at)}`}
    >
      <Text style={styles.title}>{alert.title}</Text>
      <Text style={styles.detail}>{alert.detail}</Text>
      <Text style={styles.meta}>{formatDateTime(alert.at)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderLeftWidth: 4,
    borderLeftColor: '#1d4ed8',
  },
  cardGrounded: {
    borderLeftColor: '#dc2626',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 4,
  },
  detail: {
    fontSize: 14,
    color: '#334155',
    marginBottom: 8,
    lineHeight: 20,
  },
  meta: {
    fontSize: 12,
    color: '#94a3b8',
  },
});
