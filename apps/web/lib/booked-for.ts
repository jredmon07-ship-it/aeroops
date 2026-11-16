/**
 * booked-for.ts — how the schedule names the member a booking is FOR
 * (ReservationRow.memberDisplayName, migration 0051).
 *
 * Club staff book for renters and students, so a booking's creator is often
 * not the member it is for. The list card, the board block and the month chip
 * all name that member the same way: "for Riley Member". A booking that names
 * no one gets null / its pre-0051 text, so it renders exactly as before.
 *
 * PURE: no DOM, no Next.js imports, no I/O. Unit-tested in
 * lib/__tests__/booked-for.test.ts.
 */
import { shortName } from './month-grid';

/** "for Riley Member", or null when the booking names no member. */
export function bookedForLabel(memberDisplayName: string | null | undefined): string | null {
  const name = memberDisplayName?.trim();
  return name ? `for ${name}` : null;
}

/**
 * boardBlockSecondLine — a board block's second line: who the booking is for,
 * then the other resources it holds ("for Riley Member · Morgan Ellis (CFI)").
 * Without a member it is the partner-resource line exactly as before; '' when
 * there is neither (the block then shows no second line).
 */
export function boardBlockSecondLine(
  memberDisplayName: string | null | undefined,
  partnerNames: string,
): string {
  return [bookedForLabel(memberDisplayName), partnerNames || null].filter(Boolean).join(' · ');
}

/** A month chip's people text: visible segment, tooltip and aria-label clause. */
export interface MonthChipPeople {
  /** Shown after " · " on the chip, or null for nothing. */
  segment: string | null;
  /** The chip's title (tooltip); set only when the booking names a member. */
  title: string | undefined;
  /** The aria-label clause after the time and resource (", for …, booked by …"). */
  ariaClause: string;
}

/**
 * monthChipPeople — a month chip names the member a booking is for ("for
 * Riley M.") in place of the booker's short name: staff make the bookings, so
 * the booker alone says little. The title and the aria-label carry both names
 * in full. A booking for no one keeps the booker's short name and no title,
 * exactly as before. `bookedBy` is the booker's display name when the viewer
 * may read the member list, else undefined.
 */
export function monthChipPeople(
  memberDisplayName: string | null | undefined,
  bookedBy: string | undefined,
): MonthChipPeople {
  const byClause = bookedBy ? `, booked by ${bookedBy}` : '';
  const forLabel = bookedForLabel(memberDisplayName);
  if (!forLabel) {
    return { segment: bookedBy ? shortName(bookedBy) : null, title: undefined, ariaClause: byClause };
  }
  return {
    segment: `for ${shortName(memberDisplayName!.trim())}`,
    title: bookedBy ? `${forLabel} · booked by ${bookedBy}` : forLabel,
    ariaClause: `, ${forLabel}${byClause}`,
  };
}
