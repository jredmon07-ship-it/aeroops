/**
 * compose-client.tsx — operator message composer + recipient preview + sent
 * history (FC-parity member messaging / announcements).
 *
 * States:
 *   idle     — compose form (subject, body, audience) + live recipient preview.
 *   sending  — busy button, inline validation.
 *   success  — status banner (sent / skipped opt-outs / failed) + form reset.
 *   error    — inline Alert.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/core labels.
 * NO money. Body is plain text — recipients receive it by email; opted-out
 * members are skipped (not an error).
 */
'use client';

import * as React from 'react';
import { AlertCircle, Send, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MEMBERSHIP_ROLES, ROLE_LABELS } from '@aeroops/core';
import {
  sendMemberMessageAction,
  previewMemberMessageRecipientsAction,
  type SerializedMemberMessage,
} from '../actions';
import { EmptyState } from '@/components/ui/empty-state';

interface ComposeClientProps {
  slug: string;
  initialHistory: SerializedMemberMessage[];
}

function audienceLabel(m: SerializedMemberMessage): string {
  if (m.audience === 'role' && m.role) {
    return `${ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role}s`;
  }
  return 'All active members';
}

export function ComposeClient({ slug, initialHistory }: ComposeClientProps) {
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [audience, setAudience] = React.useState<'all_active' | 'role'>('all_active');
  const [role, setRole] = React.useState<string>('renter');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [previewCount, setPreviewCount] = React.useState<number | null>(null);
  const [history, setHistory] = React.useState(initialHistory);

  // Live recipient preview whenever the audience selection changes.
  React.useEffect(() => {
    let cancelled = false;
    setPreviewCount(null);
    const input = audience === 'role' ? { audience, role } : { audience };
    previewMemberMessageRecipientsAction(input).then((result) => {
      if (cancelled) return;
      if ('ok' in result && result.ok) setPreviewCount(result.recipientCount);
    });
    return () => {
      cancelled = true;
    };
  }, [audience, role]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (subject.trim().length === 0) {
      setError('Enter a subject.');
      return;
    }
    if (body.trim().length === 0) {
      setError('Enter a message.');
      return;
    }
    setBusy(true);
    try {
      const input =
        audience === 'role'
          ? { subject: subject.trim(), body: body.trim(), audience, role }
          : { subject: subject.trim(), body: body.trim(), audience };
      const result = await sendMemberMessageAction(input, slug);
      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setError('You do not have permission to send messages.');
        } else if (result.error === 'validation') {
          setError(result.message);
        } else {
          setError("Couldn't send the message. Please try again.");
        }
        return;
      }
      const parts = [`Sent to ${result.sentCount} of ${result.recipientCount} member(s)`];
      if (result.skippedCount > 0) parts.push(`${result.skippedCount} opted out`);
      if (result.failedCount > 0) parts.push(`${result.failedCount} could not be delivered`);
      setSuccess(`${parts.join(' · ')}.`);
      setSubject('');
      setBody('');
      // Refresh sent history in place.
      const { listMemberMessagesAction } = await import('../actions');
      const refreshed = await listMemberMessagesAction();
      if ('ok' in refreshed && refreshed.ok) setHistory(refreshed.messages);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <form onSubmit={(e) => void handleSend(e)} className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert role="status">
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1">
          <Label htmlFor="msg-audience">Send to</Label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="msg-audience"
              className="flex h-9 rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              value={audience}
              onChange={(e) => setAudience(e.target.value as 'all_active' | 'role')}
              disabled={busy}
            >
              <option value="all_active">All active members</option>
              <option value="role">One role</option>
            </select>
            {audience === 'role' && (
              <select
                aria-label="Role"
                className="flex h-9 rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={busy}
              >
                {MEMBERSHIP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            )}
            <span className="text-sm text-slate-500" role="status">
              {previewCount === null ? 'Counting recipients…' : `${previewCount} recipient(s)`}
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="msg-subject">Subject</Label>
          <Input
            id="msg-subject"
            type="text"
            placeholder="e.g. Runway closure this weekend"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={busy}
            maxLength={200}
            required
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="msg-body">Message</Label>
          <Textarea
            id="msg-body"
            rows={8}
            placeholder="Write your announcement. Plain text — it will be emailed to each recipient."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            maxLength={5000}
            required
          />
          <p className="text-xs text-slate-400">
            Members who have opted out of announcements are skipped automatically.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            {busy ? 'Sending…' : 'Send message'}
          </Button>
        </div>
      </form>

      {/* Sent history */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Recent messages</h2>
        {history.length === 0 ? (
          <EmptyState icon={Send} title="No messages sent yet." className="py-6" />
        ) : (
          <ul className="space-y-2" role="list">
            {history.map((m) => (
              <li key={m.id} className="rounded-md border border-slate-200 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-slate-900">{m.subject}</p>
                  <span className="text-xs text-slate-400 whitespace-nowrap nums">
                    {new Date(m.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {audienceLabel(m)} · {m.recipientCount} recipient(s)
                </p>
                <p className="mt-2 text-sm text-slate-600 whitespace-pre-wrap line-clamp-3">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
