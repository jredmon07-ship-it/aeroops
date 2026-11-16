/**
 * notification-event-labels.test.ts — the Notifications settings page
 * (notifications/page.tsx + _components/notification-prefs-card.tsx) lists
 * every e-mail event with a readable label, including "Bookings made for
 * you" ('reservation.for_member'), and renters and students can open it.
 *
 * COVERAGE:
 *   1. Every registered event type has its own label and description (never
 *      the raw event-type fallback).
 *   2. 'reservation.for_member' reads "Bookings made for you" and says it
 *      covers booked, moved and cancelled.
 *   3. The page's gate is app:access, which every role holds — renters and
 *      students included (the card lists every event for every role).
 */
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENT_TYPES } from '@aeroops/api';
import { can } from '@aeroops/core';
import { eventLabelInfo } from '../notifications/_utils/event-labels';

describe('notification settings labels', () => {
  it('every event type has its own label and description', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const info = eventLabelInfo(eventType);
      expect(info.label).not.toBe(eventType);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });

  it('"Bookings made for you": booked, moved or cancelled by club staff', () => {
    const info = eventLabelInfo('reservation.for_member');
    expect(info.label).toBe('Bookings made for you');
    expect(info.description).toBe('When club staff book, move or cancel a booking for you.');
  });

  it('renters and students hold app:access, the settings page\'s only gate', () => {
    expect(can('renter', 'app:access')).toBe(true);
    expect(can('student', 'app:access')).toBe(true);
  });
});
