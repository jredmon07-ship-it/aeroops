/**
 * import-client.tsx — the "Import from Flight Circle" workflow (Slice P1.7).
 *
 * FLOW: pick kind → upload CSV → confirm/adjust column mapping → preview
 * (with dup/skip/error flags) → Commit → result summary. Also shows the
 * batch history for the selected kind.
 *
 * CSV parsing + column-mapping guessing run CLIENT-SIDE via the pure,
 * dependency-free @aeroops/core functions (parseCsv/guessColumnMapping) so
 * the mapping step is pre-filled with zero round trips; the CONFIRMED
 * mapping is sent to previewImportAction, which re-parses + re-validates
 * server-side (never trust the client's parse for the real staging write).
 *
 * States: idle/uploading/mapping/previewing/committing/error/done — every
 * async step has a loading indicator and specific, actionable error copy.
 *
 * BOUNDARY: imports ONLY from '@aeroops/core' (pure) + local server actions.
 * Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { Upload, AlertCircle, CheckCircle2, FileWarning, History } from 'lucide-react';
import { parseCsv, guessColumnMapping, MEMBER_FIELDS, AIRCRAFT_FIELDS } from '@aeroops/core';
import type { ColumnMapping, ImportKind, ImportSource } from '@aeroops/core';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  previewImportAction,
  commitImportAction,
  listImportBatchesAction,
} from '../actions';
import type {
  SerializedImportBatch,
  SerializedImportRow,
  PreviewImportActionResult,
  CommitImportActionResult,
} from '../actions';
import { EmptyState } from '@/components/ui/empty-state';

const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  fullName: 'Full name',
  phone: 'Phone',
  tailNumber: 'Tail number',
  make: 'Make',
  model: 'Model',
  year: 'Year',
  serialNumber: 'Serial number',
};

const MAX_FILE_BYTES = 5_000_000; // mirrors previewImport's server-side cap

const SOURCE_OPTIONS: ReadonlyArray<{ value: ImportSource; label: string }> = [
  { value: 'flight_circle', label: 'Flight Circle' },
  { value: 'myfbo', label: 'myFBO' },
  { value: 'other', label: 'Other CSV' },
];

/** Short, source-specific hint shown under the selector. Purely guidance. */
const SOURCE_HINT: Record<ImportSource, string> = {
  flight_circle:
    'Upload the CSV from Flight Circle’s Reports → Downloads screen (their “Users Export” for members, or an aircraft list).',
  myfbo:
    'myFBO retires in August 2026. Export a Members/Students or Aircraft report to CSV from myFBO, then upload it here — we’ll match up the columns for you and let you review everything before anything is created.',
  other:
    'Any tool’s CSV works. As long as it has a header row, you can map its columns to ours in the next step.',
};

interface ImportClientProps {
  slug: string;
  canMembers: boolean;
  canAircraft: boolean;
}

type Step = 'upload' | 'mapping' | 'preview' | 'done';

export function ImportClient({ slug: _slug, canMembers, canAircraft }: ImportClientProps) {
  const initialKind: ImportKind = canMembers ? 'members' : 'aircraft';
  const [kind, setKind] = React.useState<ImportKind>(initialKind);
  const [source, setSource] = React.useState<ImportSource>('flight_circle');
  const [step, setStep] = React.useState<Step>('upload');
  const [filename, setFilename] = React.useState('');
  const [csvText, setCsvText] = React.useState('');
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [mapping, setMapping] = React.useState<ColumnMapping>({});
  const [preview, setPreview] = React.useState<Extract<PreviewImportActionResult, { ok: true }> | null>(null);
  const [commitResult, setCommitResult] = React.useState<Extract<CommitImportActionResult, { ok: true }> | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = React.useState(0);

  const fields = kind === 'members' ? MEMBER_FIELDS : AIRCRAFT_FIELDS;

  function resetToUpload(nextKind: ImportKind) {
    setKind(nextKind);
    setStep('upload');
    setFilename('');
    setCsvText('');
    setHeaders([]);
    setMapping({});
    setPreview(null);
    setCommitResult(null);
    setError(null);
  }

  async function handleFileSelected(file: File) {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('This file is too large (limit ~5MB). Split it into smaller exports and try again.');
      return;
    }
    const text = await file.text();
    const { headers: parsedHeaders, rows } = parseCsv(text);
    if (parsedHeaders.length === 0 || rows.length === 0) {
      setError("This file doesn't look like a CSV with a header row and at least one data row.");
      return;
    }
    setFilename(file.name);
    setCsvText(text);
    setHeaders(parsedHeaders);
    setMapping(guessColumnMapping(parsedHeaders, kind));
    setStep('mapping');
  }

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await previewImportAction({ kind, source, filename, csvText, mapping });
      if ('error' in result) {
        setError(mapActionError(result));
        return;
      }
      if (!result.ok) {
        setError('This file has no data rows to import.');
        return;
      }
      setPreview(result);
      setStep('preview');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitImportAction({ batchId: preview.batch.id }, _slug);
      if ('error' in result) {
        setError(mapActionError(result));
        return;
      }
      if (!result.ok) {
        setError(
          'message' in result
            ? result.message
            : `Couldn't commit this import (${result.reason.replace(/_/g, ' ')}).`,
        );
        return;
      }
      setCommitResult(result);
      setStep('done');
      setHistoryRefreshKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  const availableKinds: ImportKind[] = [
    ...(canMembers ? (['members'] as const) : []),
    ...(canAircraft ? (['aircraft'] as const) : []),
  ];

  function handleSourceChange(next: ImportSource) {
    if (next === source) return;
    setSource(next);
    resetToUpload(kind); // a different provider = a fresh migration attempt
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700" id="import-source-label">
          Where are you migrating from?
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="import-source-label">
          {SOURCE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              variant={source === opt.value ? 'default' : 'outline'}
              size="sm"
              role="radio"
              aria-checked={source === opt.value}
              onClick={() => handleSourceChange(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-slate-500">{SOURCE_HINT[source]}</p>
      </div>

      {availableKinds.length > 1 && (
        <div className="flex gap-2" role="tablist" aria-label="Import kind">
          {availableKinds.map((k) => (
            <Button
              key={k}
              type="button"
              variant={kind === k ? 'default' : 'outline'}
              size="sm"
              role="tab"
              aria-selected={kind === k}
              onClick={() => resetToUpload(k)}
            >
              {k === 'members' ? 'Members' : 'Aircraft'}
            </Button>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === 'upload' && (
        <UploadStep kind={kind} onFileSelected={(f) => void handleFileSelected(f)} />
      )}

      {step === 'mapping' && (
        <MappingStep
          kind={kind}
          filename={filename}
          headers={headers}
          fields={fields as unknown as string[]}
          mapping={mapping}
          onMappingChange={setMapping}
          onBack={() => resetToUpload(kind)}
          onContinue={() => void handlePreview()}
          busy={busy}
        />
      )}

      {step === 'preview' && preview && (
        <PreviewStep
          kind={kind}
          preview={preview}
          onBack={() => setStep('mapping')}
          onCommit={() => void handleCommit()}
          busy={busy}
        />
      )}

      {step === 'done' && commitResult && (
        <DoneStep kind={kind} result={commitResult} onStartOver={() => resetToUpload(kind)} />
      )}

      <HistorySection kind={kind} refreshKey={historyRefreshKey} />
    </div>
  );
}

function mapActionError(result: { error: 'forbidden' | 'unauthenticated' | 'validation' | 'server'; message?: string }): string {
  if (result.error === 'forbidden') return 'You do not have permission to import this data.';
  if (result.error === 'unauthenticated') return 'Your session has expired. Please sign in again.';
  if (result.error === 'validation') return result.message ?? 'That file could not be processed.';
  return "Something went wrong. Please try again.";
}

// ─── Step 1: Upload ─────────────────────────────────────────────────────────

function UploadStep({ kind, onFileSelected }: { kind: ImportKind; onFileSelected: (f: File) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center space-y-3">
      <Upload className="h-8 w-8 mx-auto text-slate-400" aria-hidden="true" />
      <p className="text-sm text-slate-600">
        Upload a {kind === 'members' ? 'Users Export' : 'aircraft list'} CSV from your previous provider.
      </p>
      <Label htmlFor="import-file" className="sr-only">
        CSV file
      </Label>
      <input
        ref={inputRef}
        id="import-file"
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelected(file);
          e.target.value = '';
        }}
      />
      <Button type="button" onClick={() => inputRef.current?.click()}>
        Choose CSV file
      </Button>
    </div>
  );
}

// ─── Step 2: Mapping ────────────────────────────────────────────────────────

interface MappingStepProps {
  kind: ImportKind;
  filename: string;
  headers: string[];
  fields: string[];
  mapping: ColumnMapping;
  onMappingChange: (m: ColumnMapping) => void;
  onBack: () => void;
  onContinue: () => void;
  busy: boolean;
}

function MappingStep({
  filename,
  headers,
  fields,
  mapping,
  onMappingChange,
  onBack,
  onContinue,
  busy,
}: MappingStepProps) {
  const requiredMissing = !mapping[fields[0]!];

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Confirm columns — {filename}</h2>
        <p className="text-xs text-slate-500 mt-1">
          We guessed which column means what. Adjust anything that looks wrong before previewing.
        </p>
      </div>

      <div className="space-y-3">
        {fields.map((field, idx) => (
          <div key={field} className="flex items-center gap-3">
            <Label htmlFor={`map-${field}`} className="w-32 shrink-0 text-sm text-slate-700">
              {FIELD_LABELS[field] ?? field}
              {idx === 0 && <span className="text-danger ml-0.5">*</span>}
            </Label>
            <select
              id={`map-${field}`}
              className="h-9 flex-1 rounded-md border border-slate-300 bg-white px-2 text-sm"
              value={mapping[field] ?? ''}
              onChange={(e) => onMappingChange({ ...mapping, [field]: e.target.value || null })}
            >
              <option value="">Not mapped</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {requiredMissing && (
        <p className="text-xs text-amber-700">
          {FIELD_LABELS[fields[0]!]} is required for every row — rows without it will be skipped.
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" onClick={onContinue} disabled={busy} aria-busy={busy}>
          {busy ? 'Loading preview…' : 'Preview import'}
        </Button>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Choose a different file
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: Preview ────────────────────────────────────────────────────────

function PreviewStep({
  kind,
  preview,
  onBack,
  onCommit,
  busy,
}: {
  kind: ImportKind;
  preview: Extract<PreviewImportActionResult, { ok: true }>;
  onBack: () => void;
  onCommit: () => void;
  busy: boolean;
}) {
  const willImport = preview.rows.filter((r) => r.status === 'pending').length;
  const willSkip = preview.rows.filter((r) => r.status !== 'pending').length;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Preview — {preview.batch.filename}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {preview.batch.rowCount} row{preview.batch.rowCount === 1 ? '' : 's'} found · {willImport} will import ·{' '}
          {willSkip} will be skipped
        </p>
      </div>

      {preview.outOfScope && (
        <Alert variant="destructive" role="alert">
          <FileWarning className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{preview.batch.errorDetail}</AlertDescription>
        </Alert>
      )}

      <PreviewTable kind={kind} rows={preview.rows} />

      {preview.rows.length < preview.batch.rowCount && (
        <p className="text-xs text-slate-500">
          Showing the first {preview.rows.length} of {preview.batch.rowCount} rows — every row is staged and will be
          processed on commit.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={onCommit}
          disabled={busy || preview.outOfScope || willImport === 0}
          aria-busy={busy}
        >
          {busy ? 'Importing…' : `Import ${willImport} row${willImport === 1 ? '' : 's'}`}
        </Button>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Back to mapping
        </Button>
      </div>
    </div>
  );
}

function PreviewTable({ rows }: { kind: ImportKind; rows: SerializedImportRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No rows to preview.</p>;
  }
  const columns = Object.keys(rows[0]!.raw).slice(0, 5);
  return (
    <div className="rounded-md border border-slate-200 overflow-x-auto">
      <table className="w-full text-sm" aria-label="Import preview">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Status
            </th>
            {columns.map((c) => (
              <th key={c} scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row) => (
            <tr key={row.rowIndex} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2">
                <RowStatusChip status={row.status} errorDetail={row.errorDetail} />
              </td>
              {columns.map((c) => (
                <td key={c} className="px-3 py-2 text-slate-700 max-w-[16rem] truncate">
                  {row.raw[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowStatusChip({ status, errorDetail }: { status: string; errorDetail: string | null }) {
  if (status === 'pending' || status === 'imported') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800">
        {status === 'imported' ? 'Imported' : 'Will import'}
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-amber-800"
        title={errorDetail ?? undefined}
      >
        Duplicate — skipped
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-destructive"
      title={errorDetail ?? undefined}
    >
      Error{errorDetail ? `: ${errorDetail}` : ''}
    </span>
  );
}

// ─── Step 4: Done ───────────────────────────────────────────────────────────

function DoneStep({
  kind,
  result,
  onStartOver,
}: {
  kind: ImportKind;
  result: Extract<CommitImportActionResult, { ok: true }>;
  onStartOver: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-800">Import complete</h2>
      </div>
      <p className="text-sm text-slate-600">
        {result.batch.importedCount} {kind === 'members' ? 'member' : 'aircraft'}
        {result.batch.importedCount === 1 ? '' : 's'} imported · {result.batch.skippedCount} skipped.
      </p>
      <Button type="button" onClick={onStartOver}>
        Import another file
      </Button>
    </div>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

function HistorySection({ kind, refreshKey }: { kind: ImportKind; refreshKey: number }) {
  const [state, setState] = React.useState<
    { phase: 'loading' } | { phase: 'error' } | { phase: 'loaded'; batches: SerializedImportBatch[] }
  >({ phase: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    void listImportBatchesAction(kind).then((result) => {
      if (cancelled) return;
      if ('error' in result) {
        setState({ phase: 'error' });
        return;
      }
      setState({ phase: 'loaded', batches: result.batches });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, refreshKey]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-800">Import history</h2>
      </div>

      {state.phase === 'loading' && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading import history">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}

      {state.phase === 'error' && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>Couldn&apos;t load import history. Please refresh.</AlertDescription>
        </Alert>
      )}

      {state.phase === 'loaded' && state.batches.length === 0 && (
        <EmptyState icon={History} title="No imports yet." className="py-6" />
      )}

      {state.phase === 'loaded' && state.batches.length > 0 && (
        <div className="rounded-md border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Import history">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  File
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Imported / Skipped
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {state.batches.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-slate-700">{b.filename}</td>
                  <td className="px-3 py-2">
                    <BatchStatusChip status={b.status} outOfScope={b.outOfScope} />
                  </td>
                  <td className="px-3 py-2 text-slate-700 nums">
                    {b.importedCount} / {b.skippedCount}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 nums">{new Date(b.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BatchStatusChip({ status, outOfScope }: { status: string; outOfScope: boolean }) {
  if (outOfScope) {
    return (
      <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-amber-800">
        Out of scope
      </span>
    );
  }
  if (status === 'committed') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800">
        Committed
      </span>
    );
  }
  if (status === 'previewed') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500">
        Previewed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-destructive">
      {status}
    </span>
  );
}
