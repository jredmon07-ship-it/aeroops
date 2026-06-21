/**
 * components/ReservationCard.tsx — Card component for a single reservation.
 *
 * READ-ONLY: this component renders reservation data. No write actions.
 * (Write operations require the instant-revocation predecessor — [VERIFY-4M-SEC-1].)
 *
 * Props:
 *   reservation: MobileReservationDTO — from the schedule API.
 *   resources:   MobileResourceDTO[]  — the full resource list for label lookup.
 *
 * Renders:
 *   - Tail number(s) and resource display name(s)
 *   - Time window (local time formatted from ISO strings)
 *   - Status badge (booked / cancelled)
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MobileReservationDTO, MobileResourceDTO } from '@aeroops/core';

interface Props {
  reservation: MobileReservationDTO;
  resources: MobileResourceDTO[];
}

/**
 * formatTimeRange — formats an ISO start/end pair to a locale time range.
 * Uses the device's locale and timezone. Example: "9:00 AM – 11:00 AM"
 */
function formatTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * formatDate — formats an ISO date to a readable date string.
 * Example: "Mon, Jun 20"
 */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

export function ReservationCard({ reservation, resources }: Props): React.ReactElement {
  // Look up the resource(s) for this reservation.
  const linkedResources = useMemo(() => {
    const resourceMap = new Map(resources.map((r) => [r.id, r]));
    return reservation.resourceIds
      .map((id) => resourceMap.get(id))
      .filter((r): r is MobileResourceDTO => r !== undefined);
  }, [reservation.resourceIds, resources]);

  const isCancelled = reservation.status === 'cancelled';

  return (
    <View
      style={[styles.card, isCancelled && styles.cardCancelled]}
      accessible
      accessibilityRole="none"
      accessibilityLabel={`Reservation: ${formatDate(reservation.startAt)}, ${formatTimeRange(reservation.startAt, reservation.endAt)}${isCancelled ? ', cancelled' : ''}`}
    >
      {/* Status badge */}
      <View style={styles.header}>
        <Text style={styles.date}>{formatDate(reservation.startAt)}</Text>
        <View style={[styles.badge, isCancelled ? styles.badgeCancelled : styles.badgeBooked]}>
          <Text style={[styles.badgeText, isCancelled ? styles.badgeTextCancelled : styles.badgeTextBooked]}>
            {reservation.status}
          </Text>
        </View>
      </View>

      {/* Time window */}
      <Text style={[styles.timeRange, isCancelled && styles.textCancelled]}>
        {formatTimeRange(reservation.startAt, reservation.endAt)}
      </Text>

      {/* Aircraft / resource info */}
      {linkedResources.length > 0 ? (
        <View style={styles.resources}>
          {linkedResources.map((resource) => (
            <View key={resource.id} style={styles.resourceChip}>
              {resource.tailNumber ? (
                <Text style={styles.tailNumber}>{resource.tailNumber}</Text>
              ) : null}
              <Text style={styles.resourceName}>{resource.displayName}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Notes */}
      {reservation.notes ? (
        <Text style={styles.notes} numberOfLines={2}>
          {reservation.notes}
        </Text>
      ) : null}
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
  cardCancelled: {
    borderLeftColor: '#94a3b8',
    opacity: 0.7,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  date: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '500',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  badgeBooked: {
    backgroundColor: '#dbeafe',
  },
  badgeCancelled: {
    backgroundColor: '#f1f5f9',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  badgeTextBooked: {
    color: '#1d4ed8',
  },
  badgeTextCancelled: {
    color: '#64748b',
  },
  timeRange: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  textCancelled: {
    color: '#94a3b8',
  },
  resources: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  resourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 6,
  },
  tailNumber: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0369a1',
  },
  resourceName: {
    fontSize: 13,
    color: '#0369a1',
  },
  notes: {
    marginTop: 8,
    fontSize: 13,
    color: '#64748b',
    fontStyle: 'italic',
  },
});
