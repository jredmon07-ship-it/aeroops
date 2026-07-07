/**
 * notifications/templates.ts — pure email templates, one per event type
 * (Slice P1.3). Framework-agnostic; no I/O; no Date.now() (all inputs
 * injected).
 *
 * COPY POSTURE (compliance-load-bearing):
 *   PLAIN, operator-operational language only. NO FAA/airworthiness/
 *   currency/Part-61/141/91/43 determination language anywhere. NO money
 *   advice (a payment-failed email states the fact + points the member back
 *   to the operator; it does not instruct them on debt/collections). Text-
 *   first: every template returns a `text` body that stands alone; `html`
 *   is a minimal, unstyled wrapper (no external assets, no tracking pixels).
 *
 * money is rendered from INTEGER CENTS via formatCents — never a float.
 */
import type {
  NotificationTemplateDataMap,
  RenderedEmail,
  ReservationCreatedData,
  SquawkReportedData,
  AircraftGroundedData,
  InvoiceFinalizedData,
  PaymentFailedData,
  DuesGeneratedData,
  MaintenanceDueData,
  OrgAnnouncementData,
} from './email-event-types.js';
import type { NotificationEventType } from './email-event-types.js';

/** INTEGER CENTS → "$12.34" — never float math. */
function formatCents(amountCents: number): string {
  const sign = amountCents < 0 ? '-' : '';
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${cents}`;
}

function formatDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Minimal, unstyled HTML wrapper — no external assets, no tracking. */
function wrapHtml(paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
  return `<!doctype html><html><body>${body}</body></html>`;
}

/**
 * escapeHtml — minimal HTML-entity escaping for OPERATOR-AUTHORED free text
 * (Slice FC-P1's announcement body/subject). The other templates above
 * interpolate short, structured operator fields (a title, a reason) that
 * predate this escaping need; org.announcement is the first template to
 * carry an arbitrarily long free-text field, so it is escaped explicitly
 * here rather than widening every existing template's behavior.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderReservationCreated(data: ReservationCreatedData): RenderedEmail {
  const tails = data.resourceIds.length > 0 ? data.resourceIds.join(', ') : 'the requested resource';
  const text =
    `Your reservation is confirmed.\n\n` +
    `Resource(s): ${tails}\n` +
    `Start: ${formatDateTime(data.startAt)}\n` +
    `End: ${formatDateTime(data.endAt)}\n`;
  return {
    subject: 'Reservation confirmed',
    text,
    html: wrapHtml([
      'Your reservation is confirmed.',
      `Resource(s): ${tails}`,
      `Start: ${formatDateTime(data.startAt)}`,
      `End: ${formatDateTime(data.endAt)}`,
    ]),
  };
}

function renderSquawkReported(data: SquawkReportedData): RenderedEmail {
  const text =
    `A squawk was recorded.\n\n` +
    `Title: ${data.title}\n` +
    `Severity: ${data.severity}\n\n` +
    `This is a record of the report you filed — it does not by itself ground the aircraft.`;
  return {
    subject: 'Squawk reported',
    text,
    html: wrapHtml([
      'A squawk was recorded.',
      `Title: ${data.title}`,
      `Severity: ${data.severity}`,
      'This is a record of the report you filed — it does not by itself ground the aircraft.',
    ]),
  };
}

function renderAircraftGrounded(data: AircraftGroundedData): RenderedEmail {
  const text =
    `An aircraft was grounded.\n\n` +
    `Reason: ${data.reason}\n\n` +
    `This reflects an operator record, not an FAA airworthiness determination.`;
  return {
    subject: 'Aircraft grounded',
    text,
    html: wrapHtml([
      'An aircraft was grounded.',
      `Reason: ${data.reason}`,
      'This reflects an operator record, not an FAA airworthiness determination.',
    ]),
  };
}

function renderInvoiceFinalized(data: InvoiceFinalizedData): RenderedEmail {
  const amount = formatCents(data.totalCents);
  const text = `Your invoice is ready.\n\nInvoice: ${data.invoiceId}\nAmount: ${amount}\n`;
  return {
    subject: 'Invoice ready',
    text,
    html: wrapHtml([`Your invoice is ready.`, `Invoice: ${data.invoiceId}`, `Amount: ${amount}`]),
  };
}

function renderPaymentFailed(data: PaymentFailedData): RenderedEmail {
  const amount = formatCents(data.amountCents);
  const text =
    `A payment on your account did not go through.\n\n` +
    `Invoice: ${data.invoiceId}\nAmount: ${amount}\n\n` +
    `Please contact your operator to arrange payment.`;
  return {
    subject: 'Payment did not go through',
    text,
    html: wrapHtml([
      'A payment on your account did not go through.',
      `Invoice: ${data.invoiceId}`,
      `Amount: ${amount}`,
      'Please contact your operator to arrange payment.',
    ]),
  };
}

function renderDuesGenerated(data: DuesGeneratedData): RenderedEmail {
  const amount = formatCents(data.amountCents);
  const text =
    `Your dues invoice for ${data.periodKey} is ready.\n\n` +
    `Invoice: ${data.invoiceId}\nAmount: ${amount}\n`;
  return {
    subject: 'Dues invoice ready',
    text,
    html: wrapHtml([
      `Your dues invoice for ${data.periodKey} is ready.`,
      `Invoice: ${data.invoiceId}`,
      `Amount: ${amount}`,
    ]),
  };
}

function renderMaintenanceDue(data: MaintenanceDueData): RenderedEmail {
  const lines = data.items.map((i) => `- ${i.title} (${i.status === 'overdue' ? 'overdue' : 'due soon'})`);
  const text =
    `Maintenance items need attention.\n\n` +
    `Overdue: ${data.overdueCount}\nDue soon: ${data.dueSoonCount}\n\n` +
    (lines.length > 0 ? `${lines.join('\n')}\n\n` : '') +
    `This reflects thresholds you set — it does not by itself determine airworthiness; a mechanic makes that call.`;
  return {
    subject: 'Maintenance items due',
    text,
    html: wrapHtml([
      'Maintenance items need attention.',
      `Overdue: ${data.overdueCount}`,
      `Due soon: ${data.dueSoonCount}`,
      ...lines,
      'This reflects thresholds you set — it does not by itself determine airworthiness; a mechanic makes that call.',
    ]),
  };
}

function renderOrgAnnouncement(data: OrgAnnouncementData): RenderedEmail {
  const footer = `— Sent by ${data.orgName} via AeroOps.`;
  const text = `${data.body}\n\n${footer}`;
  const escapedBodyHtml = escapeHtml(data.body).replace(/\n/g, '<br>');
  return {
    subject: data.subject,
    text,
    html: wrapHtml([escapedBodyHtml, escapeHtml(footer)]),
  };
}

/**
 * renderNotificationTemplate — dispatch to the per-event pure renderer.
 *
 * Generic over E so callers get the right TemplateData shape checked at the
 * call site (see send-notification.ts). The switch is exhaustive over
 * NotificationEventType — adding a new event type without a matching branch
 * here is a compile error (the `never` fallthrough).
 */
export function renderNotificationTemplate<E extends NotificationEventType>(
  eventType: E,
  data: NotificationTemplateDataMap[E],
): RenderedEmail {
  switch (eventType) {
    case 'reservation.created':
      return renderReservationCreated(data as ReservationCreatedData);
    case 'squawk.reported':
      return renderSquawkReported(data as SquawkReportedData);
    case 'aircraft.grounded':
      return renderAircraftGrounded(data as AircraftGroundedData);
    case 'invoice.finalized':
      return renderInvoiceFinalized(data as InvoiceFinalizedData);
    case 'payment.failed':
      return renderPaymentFailed(data as PaymentFailedData);
    case 'dues.generated':
      return renderDuesGenerated(data as DuesGeneratedData);
    case 'maintenance.due':
      return renderMaintenanceDue(data as MaintenanceDueData);
    case 'org.announcement':
      return renderOrgAnnouncement(data as OrgAnnouncementData);
    default: {
      const _exhaustive: never = eventType;
      throw new Error(`[notifications] unknown event type: ${String(_exhaustive)}`);
    }
  }
}
