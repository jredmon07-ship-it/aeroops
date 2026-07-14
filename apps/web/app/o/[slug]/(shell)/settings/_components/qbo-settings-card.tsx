/**
 * qbo-settings-card.tsx — QuickBooks Online integration card (Slice QB1).
 *
 * Rendered on the org settings page (already gated server-side on
 * org:manage_settings — only owner/manager ever reach this page). Shows:
 *   - provider-configured banner (deployment-level env not set → informational)
 *   - connection status + realm + Connect/Disconnect
 *   - per-line-item-kind GL account mapping editor (the "real-time line-item
 *     GL mapping" competitive wedge — each kind maps to its own QBO Item)
 *   - the last 20 export-log rows (visible push history — the other half of
 *     the competitive wedge: a self-serve, visible sync log vs. a black-box
 *     batch export)
 *
 * States: loading / error / populated (sub-states per section).
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 * Never '@aeroops/db'. Server actions enforce the real caps.
 *
 * NO money, NO Stripe, NO card/bank data.
 */
'use client';

import * as React from 'react';
import { AlertCircle, Link2, Link2Off, RefreshCw, Plus, Trash2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast-store';
import type { QboLineKind } from '@aeroops/api';
import {
  getQboStatusAction,
  setQboAccountMappingAction,
  deleteQboAccountMappingAction,
  disconnectQboAction,
  getQboAutoExportAction,
  setQboAutoExportAction,
  backfillQboExportsAction,
} from '../actions';
import type { SerializedQboStatus } from '../actions';
import { EmptyState } from '@/components/ui/empty-state';

const LINE_KIND_LABELS: Record<QboLineKind, string> = {
  wet_hourly: 'Aircraft rental (wet hourly)',
  dry_hourly: 'Aircraft rental (dry hourly)',
  instruction: 'Instructor time',
  flat: 'Flat fees',
  other: 'Other (no rate schedule)',
  default: 'Default (catch-all)',
};

const LINE_KIND_ORDER: QboLineKind[] = ['wet_hourly', 'dry_hourly', 'instruction', 'flat', 'other', 'default'];

type CardState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'populated'; status: SerializedQboStatus };

interface QboSettingsCardProps {
  slug: string;
}

export function QboSettingsCard({ slug }: QboSettingsCardProps) {
  const [state, setState] = React.useState<CardState>({ phase: 'loading' });
  const [connecting, setConnecting] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    const result = await getQboStatusAction();
    if ('error' in result) {
      const msg =
        result.error === 'forbidden' || result.error === 'unauthenticated'
          ? 'You do not have permission to view QuickBooks settings.'
          : "Couldn't load QuickBooks status. Please refresh.";
      setState({ phase: 'error', message: msg });
      return;
    }
    setState({ phase: 'populated', status: result });
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleDisconnect() {
    setDisconnecting(true);
    setActionError(null);
    try {
      const result = await disconnectQboAction(slug);
      if ('error' in result) {
        setActionError("Couldn't disconnect QuickBooks. Please try again.");
      } else if (!result.ok) {
        setActionError('QuickBooks is not currently connected.');
      }
      await load();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-4 space-y-4" aria-label="QuickBooks Online integration">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">QuickBooks Online</h2>
      </div>

      {state.phase === 'loading' && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading QuickBooks status">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}

      {state.phase === 'error' && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'populated' && (
        <div className="space-y-4">
          {!state.status.providerConfigured && (
            <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-md px-3 py-2">
              QuickBooks is not configured on this deployment. Set QBO_CLIENT_ID / QBO_CLIENT_SECRET /
              QBO_REDIRECT_URI to enable connecting.
            </p>
          )}

          {actionError && (
            <Alert variant="destructive" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          {/* Connection status */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2">
            <div className="text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-300">Status: </span>
              <StatusChip status={state.status.connection?.status ?? 'disconnected'} />
              {state.status.connection?.realmId && (
                <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">Company file: {state.status.connection.realmId}</span>
              )}
            </div>
            <div className="flex gap-2">
              {state.status.connection?.status === 'connected' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void handleDisconnect()}
                  disabled={disconnecting}
                  aria-busy={disconnecting}
                >
                  <Link2Off className="h-3 w-3 mr-1" aria-hidden="true" />
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              ) : (
                <Button
                  asChild
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!state.status.providerConfigured || connecting}
                >
                  <a href={`/api/integrations/qbo/connect`} onClick={() => setConnecting(true)}>
                    <Link2 className="h-3 w-3 mr-1" aria-hidden="true" />
                    Connect
                  </a>
                </Button>
              )}
            </div>
          </div>

          {/* Auto-sync + backfill (migration 0046) */}
          <SyncControls
            slug={slug}
            connected={state.status.connection?.status === 'connected'}
            onBackfilled={() => void load()}
          />

          {/* Account mapping editor */}
          <AccountMappingEditor
            slug={slug}
            mapping={state.status.accountMapping}
            onChanged={() => void load()}
          />

          {/* Export log */}
          <ExportLogTable exports={state.status.recentExports} />
        </div>
      )}
    </div>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: 'connected' | 'disconnected' | 'error' }) {
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
        Connected
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-destructive">
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
      Not connected
    </span>
  );
}

// ─── SyncControls (auto-sync toggle + backfill) ───────────────────────────────

interface SyncControlsProps {
  slug: string;
  connected: boolean;
  onBackfilled: () => void;
}

type AutoExportState =
  | { phase: 'loading' }
  | { phase: 'ready'; autoExportInvoices: boolean; available: boolean }
  | { phase: 'error' };

function SyncControls({ slug, connected, onBackfilled }: SyncControlsProps) {
  const [state, setState] = React.useState<AutoExportState>({ phase: 'loading' });
  const [toggling, setToggling] = React.useState(false);
  const [backfilling, setBackfilling] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getQboAutoExportAction();
      if (cancelled) return;
      if ('error' in result) {
        setState({ phase: 'error' });
        return;
      }
      setState({
        phase: 'ready',
        autoExportInvoices: result.setting.autoExportInvoices,
        available: result.setting.available,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(next: boolean) {
    setToggling(true);
    try {
      const result = await setQboAutoExportAction(slug, next);
      if ('error' in result) {
        toast.error('Could not update auto-sync. Please try again.');
        return;
      }
      if (!result.ok) {
        toast.error('Auto-sync isn’t available yet.');
        return;
      }
      setState((prev) =>
        prev.phase === 'ready' ? { ...prev, autoExportInvoices: result.autoExportInvoices } : prev,
      );
      toast.success(
        result.autoExportInvoices
          ? 'Finalized invoices will now auto-export to QuickBooks.'
          : 'Auto-export is off. Export invoices manually when you choose.',
      );
    } finally {
      setToggling(false);
    }
  }

  async function handleBackfill() {
    setBackfilling(true);
    try {
      const result = await backfillQboExportsAction(slug);
      if ('error' in result) {
        toast.error('Could not sync unexported invoices. Please try again.');
        return;
      }
      const failedCount = result.failed + result.paymentsFailed;
      const remainingCount = result.remaining + result.paymentsRemaining;
      toast.success(
        `Synced ${result.exported} invoice${result.exported === 1 ? '' : 's'}` +
          (result.paymentsExported > 0
            ? ` and ${result.paymentsExported} payment${result.paymentsExported === 1 ? '' : 's'}`
            : '') +
          ' to QuickBooks' +
          (failedCount > 0 ? `, ${failedCount} failed` : '') +
          (remainingCount > 0 ? `. ${remainingCount} still remaining. Run again to continue.` : '.'),
      );
      onBackfilled();
    } finally {
      setBackfilling(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 dark:border-slate-800 px-3 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Sync
      </h3>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Auto-export finalized invoices to QuickBooks as they are finalized. This is a bookkeeping
        export of invoice records — no money is moved.
      </p>

      {state.phase === 'loading' && <Skeleton className="h-6 w-40" />}

      {state.phase === 'error' && (
        <p className="text-xs text-slate-500 dark:text-slate-400">Couldn’t load the auto-sync setting.</p>
      )}

      {state.phase === 'ready' && !state.available && (
        <Alert role="status">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>Auto-sync becomes available in an upcoming update.</AlertDescription>
        </Alert>
      )}

      {state.phase === 'ready' && state.available && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {state.autoExportInvoices ? 'Auto-export is ON' : 'Auto-export is OFF'}
            </span>
            <Button
              type="button"
              size="sm"
              variant={state.autoExportInvoices ? 'outline' : 'default'}
              className="h-7 text-xs"
              disabled={toggling}
              aria-busy={toggling}
              onClick={() => void handleToggle(!state.autoExportInvoices)}
            >
              {state.autoExportInvoices ? 'Turn off' : 'Turn on auto-export'}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Catch up finalized invoices and their payments not yet in QuickBooks (up to 50 of each per run).
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs shrink-0"
              disabled={backfilling || !connected}
              aria-busy={backfilling}
              onClick={() => void handleBackfill()}
              title={connected ? undefined : 'Connect QuickBooks first'}
            >
              <UploadCloud className="h-3 w-3 mr-1" aria-hidden="true" />
              {backfilling ? 'Syncing…' : 'Sync all unexported'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AccountMappingEditor ─────────────────────────────────────────────────────

interface AccountMappingEditorProps {
  slug: string;
  mapping: SerializedQboStatus['accountMapping'];
  onChanged: () => void;
}

function AccountMappingEditor({ slug, mapping, onChanged }: AccountMappingEditorProps) {
  const [editingKind, setEditingKind] = React.useState<QboLineKind | null>(null);
  const [itemId, setItemId] = React.useState('');
  const [itemName, setItemName] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const byKind = new Map(mapping.map((m) => [m.lineKind, m]));

  function startEdit(kind: QboLineKind) {
    const existing = byKind.get(kind);
    setItemId(existing?.qboItemId ?? '');
    setItemName(existing?.qboItemName ?? '');
    setError(null);
    setEditingKind(kind);
  }

  async function handleSave() {
    if (!editingKind) return;
    if (!itemId.trim() || !itemName.trim()) {
      setError('Both a QuickBooks item ID and name are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await setQboAccountMappingAction(
        { lineKind: editingKind, qboItemId: itemId.trim(), qboItemName: itemName.trim() },
        slug,
      );
      if ('error' in result) {
        setError(
          result.error === 'validation'
            ? result.message
            : result.error === 'forbidden' || result.error === 'unauthenticated'
              ? 'You do not have permission to change this mapping.'
              : "Couldn't save the mapping. Please try again.",
        );
        return;
      }
      setEditingKind(null);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(kind: QboLineKind) {
    setError(null);
    const result = await deleteQboAccountMappingAction(kind, slug);
    if ('error' in result || !result.ok) {
      setError("Couldn't remove the mapping. Please try again.");
      return;
    }
    onChanged();
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Line-item → QuickBooks account mapping
      </h3>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Each AeroOps charge kind exports to its own QuickBooks Item/account — never lumped into one line.
        Unmapped kinds refuse to export (set a &ldquo;Default&rdquo; row as a catch-all).
      </p>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm" aria-label="QuickBooks account mapping">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Kind
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                QuickBooks item
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {LINE_KIND_ORDER.map((kind) => {
              const existing = byKind.get(kind);
              const isEditing = editingKind === kind;
              return (
                <tr key={kind} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-3 py-2 align-top text-slate-700 dark:text-slate-300">{LINE_KIND_LABELS[kind]}</td>
                  <td className="px-3 py-2 align-top">
                    {isEditing ? (
                      <div className="flex flex-col gap-1 max-w-xs">
                        <Label htmlFor={`item-id-${kind}`} className="sr-only">
                          QuickBooks item ID
                        </Label>
                        <Input
                          id={`item-id-${kind}`}
                          placeholder="QBO item ID"
                          value={itemId}
                          onChange={(e) => setItemId(e.target.value)}
                          disabled={saving}
                          className="h-7 text-xs"
                        />
                        <Label htmlFor={`item-name-${kind}`} className="sr-only">
                          QuickBooks item name
                        </Label>
                        <Input
                          id={`item-name-${kind}`}
                          placeholder="QBO item name"
                          value={itemName}
                          onChange={(e) => setItemName(e.target.value)}
                          disabled={saving}
                          className="h-7 text-xs"
                        />
                      </div>
                    ) : existing ? (
                      <span className="text-slate-700 dark:text-slate-300">
                        {existing.qboItemName} <span className="text-slate-400 dark:text-slate-500">({existing.qboItemId})</span>
                      </span>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500 italic">Not mapped</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => void handleSave()}
                          disabled={saving}
                          aria-busy={saving}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setEditingKind(null)}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => startEdit(kind)}
                        >
                          <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                          {existing ? 'Edit' : 'Map'}
                        </Button>
                        {existing && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
                            onClick={() => void handleRemove(kind)}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ExportLogTable ───────────────────────────────────────────────────────────

function ExportLogTable({ exports }: { exports: SerializedQboStatus['recentExports'] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Recent export activity</h3>
      {exports.length === 0 ? (
        <EmptyState icon={RefreshCw} title="No exports yet." className="py-6" />
      ) : (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
          <table className="w-full text-sm" aria-label="QuickBooks export log">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell">
                  Detail
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {exports.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-3 py-2 capitalize text-slate-700 dark:text-slate-300">{row.entityType}</td>
                  <td className="px-3 py-2">
                    {row.status === 'exported' && (
                      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
                        Exported
                      </span>
                    )}
                    {row.status === 'error' && (
                      <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-destructive">
                        Error
                      </span>
                    )}
                    {row.status === 'pending' && (
                      <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell max-w-xs truncate">
                    {row.status === 'exported' ? row.qboId : row.errorDetail}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 nums">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
