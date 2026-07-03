/**
 * components/SquawkCard.tsx — Card for a single row in the open-squawks list.
 *
 * READ-ONLY: renders MobileSquawkDTO. No write actions (reporting/resolving
 * a squawk is a write surface — deferred behind [VERIFY-4M-SEC-1]).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MobileSquawkDTO } from '@aeroops/core';

interface Props {
  squawk: MobileSquawkDTO;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

const SEVERITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  grounding: 'Grounding',
};

export function SquawkCard({ squawk }: Props): React.ReactElement {
  const isGrounding = squawk.severity === 'grounding';

  return (
    <View
      style={[styles.card, isGrounding && styles.cardGrounding]}
      accessible
      accessibilityRole="none"
      accessibilityLabel={`${squawk.tailNumber || 'Unknown aircraft'}: ${squawk.title}, severity ${
        SEVERITY_LABELS[squawk.severity] ?? squawk.severity
      }, reported ${formatDate(squawk.reportedAt)}`}
    >
      <View style={styles.header}>
        <Text style={styles.tail}>{squawk.tailNumber || 'Unknown aircraft'}</Text>
        <View style={[styles.badge, isGrounding ? styles.badgeGrounding : styles.badgeDefault]}>
          <Text style={[styles.badgeText, isGrounding && styles.badgeTextGrounding]}>
            {SEVERITY_LABELS[squawk.severity] ?? squawk.severity}
          </Text>
        </View>
      </View>
      <Text style={styles.title}>{squawk.title}</Text>
      <Text style={styles.meta}>Reported {formatDate(squawk.reportedAt)}</Text>
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
    borderLeftColor: '#f59e0b',
  },
  cardGrounding: {
    borderLeftColor: '#dc2626',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  tail: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  badgeDefault: {
    backgroundColor: '#fffbeb',
  },
  badgeGrounding: {
    backgroundColor: '#fef2f2',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#b45309',
  },
  badgeTextGrounding: {
    color: '#dc2626',
  },
  title: {
    fontSize: 15,
    color: '#334155',
    marginBottom: 6,
  },
  meta: {
    fontSize: 12,
    color: '#94a3b8',
  },
});
