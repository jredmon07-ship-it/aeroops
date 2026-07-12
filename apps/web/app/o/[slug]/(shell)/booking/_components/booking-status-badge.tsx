/**
 * booking-status-badge.tsx — Status badge chip for booking requests.
 *
 * Mirrors work-order-status-badge.tsx design pattern.
 * PURE client display — no I/O.
 */
import * as React from 'react';
import { statusBadgeConfig } from './booking-utils';
import type { BookingRequestStatus } from './booking-utils';

interface BookingStatusBadgeProps {
  status: BookingRequestStatus | string;
  className?: string;
}

export function BookingStatusBadge({
  status,
  className = '',
}: BookingStatusBadgeProps) {
  const config = statusBadgeConfig(status);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 ${config.cls} ${className}`}
    >
      {config.label}
    </span>
  );
}
