/**
 * components/AircraftCard.tsx — Card for a single row in the fleet list.
 *
 * READ-ONLY: renders MobileAircraftListDTO. No write actions.
 * Tapping navigates to /fleet/[id] (read-only detail — see fleet/[id].tsx).
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MobileAircraftListDTO } from '@aeroops/core';

interface Props {
  aircraft: MobileAircraftListDTO;
  onPress: () => void;
}

export function AircraftCard({ aircraft, onPress }: Props): React.ReactElement {
  const subtitle = [aircraft.make, aircraft.model].filter(Boolean).join(' ');

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${aircraft.tailNumber}${subtitle ? `, ${subtitle}` : ''}${
        aircraft.grounded ? ', grounded' : ''
      }${!aircraft.active ? ', inactive' : ''}`}
    >
      <View style={styles.row}>
        <View style={styles.identity}>
          <Text style={styles.tail}>{aircraft.tailNumber}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        <View style={styles.badges}>
          {aircraft.grounded ? (
            <View style={[styles.badge, styles.badgeGrounded]}>
              <Text style={styles.badgeTextGrounded}>Grounded</Text>
            </View>
          ) : null}
          {!aircraft.active ? (
            <View style={[styles.badge, styles.badgeInactive]}>
              <Text style={styles.badgeTextInactive}>Inactive</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
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
  cardPressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  identity: {
    flexShrink: 1,
  },
  tail: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 2,
  },
  badges: {
    flexDirection: 'row',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeGrounded: {
    backgroundColor: '#fef2f2',
  },
  badgeTextGrounded: {
    fontSize: 11,
    fontWeight: '700',
    color: '#dc2626',
  },
  badgeInactive: {
    backgroundColor: '#f1f5f9',
  },
  badgeTextInactive: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
});
