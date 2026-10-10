/**
 * event-labels.ts — pure display helpers for notification event types
 * (Slice P1.3). No DOM/React imports so this is unit-testable standalone.
 */
import type { NotificationEventType } from '@aeroops/api';

export interface EventLabelInfo {
  label: string;
  description: string;
}

const EVENT_LABELS: Record<NotificationEventType, EventLabelInfo> = {
  'reservation.created': {
    label: 'Reservation confirmations',
    description: 'When a reservation you book is confirmed.',
  },
  'squawk.reported': {
    label: 'Squawk report confirmations',
    description: 'When a squawk you report is recorded.',
  },
  'aircraft.grounded': {
    label: 'Aircraft grounded alerts',
    description: 'When you ground an aircraft.',
  },
  'maintenance.due': {
    label: 'Maintenance due',
    description: 'A maintenance item on an aircraft is coming due or overdue.',
  },
  'org.announcement': {
    label: 'Organization announcements',
    description: 'When your operator posts an announcement.',
  },
};

/** Pure lookup — falls back to the raw event type string if ever unmapped. */
export function eventLabelInfo(eventType: NotificationEventType): EventLabelInfo {
  return EVENT_LABELS[eventType] ?? { label: eventType, description: '' };
}
