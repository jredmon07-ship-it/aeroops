/**
 * download-csv-button.tsx — client "Download CSV" button for the pilot
 * logbook (Slice P2). Calls the export action, builds a Blob client-side,
 * and triggers a browser download. NO card/bank data — CSV text only.
 *
 * States: idle / pending (spinner, disabled) / error (inline destructive text).
 */
'use client';

import * as React from 'react';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface DownloadCsvAction {
  (): Promise<
    | { ok: true; filename: string; csv: string }
    | { error: 'forbidden' | 'unauthenticated' | 'validation' | 'server'; message?: string }
  >;
}

interface DownloadCsvButtonProps {
  action: DownloadCsvAction;
  label?: string;
}

export function DownloadCsvButton({ action, label = 'Download CSV' }: DownloadCsvButtonProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if ('error' in result) {
        setError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to export this logbook.'
            : 'Could not export the logbook. Please try again.',
        );
        return;
      }
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not export the logbook. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="outline" onClick={handleClick} disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden="true" />
            Exporting…
          </>
        ) : (
          <>
            <Download className="h-4 w-4 mr-1" aria-hidden="true" />
            {label}
          </>
        )}
      </Button>
      {error && (
        <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
