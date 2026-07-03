/**
 * documents-card.tsx — "Documents" card for the Fleet detail (aircraft) and
 * People detail (member) pages (Slice P1.6).
 *
 * Self-fetching client component (mirrors dispatch-requirements-card.tsx's
 * pattern): loads its own document list on mount via listDocumentsAction,
 * uploads via a two-step flow (requestUploadAction → browser PUT directly to
 * object storage → confirmUploadAction), downloads via getDownloadUrlAction
 * (window.open the short-lived signed URL), deletes via deleteDocumentAction.
 *
 * States: loading (skeleton) / empty / error (non-fatal inline alert) /
 * populated / "storage not enabled by your operator" (when STORAGE_* env is
 * unset — a typed refusal, never a crash).
 *
 * COMPLIANCE (HARD LINE) [VERIFY-P1.6-A]: documents are STORED, NEVER
 * INTERPRETED. category is a FREE-TEXT operator label — a filing-cabinet
 * tab, not a computed classification. Verbatim disclaimer below.
 *
 * BOUNDARY: imports ONLY from ./documents-actions (which itself imports only
 * @aeroops/api). Never @aeroops/db.
 */
'use client';

import * as React from 'react';
import {
  FileText,
  Upload,
  Download,
  Trash2,
  Loader2,
  AlertCircle,
  FileWarning,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  requestUploadAction,
  confirmUploadAction,
  listDocumentsAction,
  getDownloadUrlAction,
  deleteDocumentAction,
} from './documents-actions';
import type { SerializedDocumentView } from './documents-actions';
import type { DocumentOwnerType } from '@aeroops/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ─── Upload dialog ────────────────────────────────────────────────────────────

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerType: DocumentOwnerType;
  ownerId: string;
  onSuccess: (doc: SerializedDocumentView) => void;
}

function UploadDialog({ open, onOpenChange, ownerType, ownerId, onSuccess }: UploadDialogProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [category, setCategory] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setCategory('');
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const requestResult = await requestUploadAction({
        ownerType,
        ownerId,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        category: category.trim() || undefined,
      });

      if ('error' in requestResult) {
        if (requestResult.error === 'validation') {
          setError(requestResult.message);
          return;
        }
        if (requestResult.error === 'forbidden' || requestResult.error === 'unauthenticated') {
          setError('You do not have permission to upload documents here.');
          return;
        }
        setError('Something went wrong. Please try again.');
        return;
      }
      if (!requestResult.ok) {
        if (requestResult.reason === 'not_configured') {
          setError('File storage is not enabled by your operator.');
          return;
        }
        setError('Could not upload — the owner was not found.');
        return;
      }

      // Browser PUTs the file bytes DIRECTLY to object storage — the file
      // never passes through the AeroOps server.
      const putResponse = await fetch(requestResult.uploadUrl, {
        method: requestResult.uploadMethod,
        body: file,
      });
      if (!putResponse.ok) {
        setError('Upload failed while sending the file. Please try again.');
        return;
      }

      const confirmResult = await confirmUploadAction({ documentId: requestResult.document.id });
      if ('error' in confirmResult || !confirmResult.ok) {
        setError('The file uploaded, but we could not confirm it. Try refreshing.');
        return;
      }

      onSuccess(confirmResult.document);
      onOpenChange(false);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
        </DialogHeader>

        {/* [VERIFY-P1.6-A] operator-data framing */}
        <p className="text-sm text-slate-500">
          Files are stored as-is — AeroOps does not read, scan, or interpret document
          contents. The category label below is a free-text tag you choose (e.g.
          &ldquo;Medical&rdquo;, &ldquo;Insurance&rdquo;) — it is not verified.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="doc-file-input">
              File <span aria-hidden="true" className="text-red-500">*</span>
            </Label>
            <Input
              id="doc-file-input"
              type="file"
              ref={fileInputRef}
              disabled={isUploading}
              aria-required="true"
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'doc-upload-err' : undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-category-input">Category (optional)</Label>
            <Input
              id="doc-category-input"
              type="text"
              placeholder="e.g. Medical, Insurance, POH"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isUploading}
              maxLength={100}
            />
          </div>

          {error && (
            <p id="doc-upload-err" role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isUploading}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isUploading}>
              {isUploading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden="true" />Uploading…</>
              ) : (
                'Upload'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: 'pending' | 'stored' }) {
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-amber-800">
        Uploading…
      </span>
    );
  }
  return null;
}

// ─── Main card ────────────────────────────────────────────────────────────────

export interface DocumentsCardProps {
  ownerType: DocumentOwnerType;
  ownerId: string;
  /** Whether the session has the write cap (people:manage | fleet:manage). Controls Upload/Delete visibility. The server action re-gates independently. */
  canManage: boolean;
}

export function DocumentsCard({ ownerType, ownerId, canManage }: DocumentsCardProps) {
  const [documents, setDocuments] = React.useState<SerializedDocumentView[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [notConfigured, setNotConfigured] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<SerializedDocumentView | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [downloadingIds, setDownloadingIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    listDocumentsAction({ ownerType, ownerId })
      .then((result) => {
        if (cancelled) return;
        setLoading(false);
        if ('error' in result || !result.ok) {
          setLoadError(true);
          return;
        }
        setDocuments(result.documents);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ownerType, ownerId]);

  async function handleDownload(doc: SerializedDocumentView) {
    setDownloadingIds((prev) => new Set(prev).add(doc.id));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[doc.id];
      return next;
    });
    try {
      const result = await getDownloadUrlAction({ documentId: doc.id });
      if ('error' in result) {
        setRowErrors((prev) => ({ ...prev, [doc.id]: 'Could not get a download link.' }));
        return;
      }
      if (!result.ok) {
        if (result.reason === 'not_configured') {
          setNotConfigured(true);
          return;
        }
        setRowErrors((prev) => ({ ...prev, [doc.id]: 'Document not found.' }));
        return;
      }
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch {
      setRowErrors((prev) => ({ ...prev, [doc.id]: 'Could not get a download link.' }));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = await deleteDocumentAction({ documentId: deleteTarget.id });
      if ('error' in result || !result.ok) {
        setRowErrors((prev) => ({ ...prev, [deleteTarget.id]: 'Could not delete this document.' }));
        return;
      }
      setDocuments((prev) => (prev ?? []).filter((d) => d.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      setRowErrors((prev) => ({ ...prev, [deleteTarget.id]: 'Could not delete this document.' }));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Documents</h2>
            {!loading && !loadError && documents !== null && documents.length > 0 && (
              <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[10px] font-semibold text-brand-ink">
                {documents.length}
              </span>
            )}
          </div>
          {canManage && !loading && !loadError && (
            <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 mr-1" aria-hidden="true" />
              Upload
            </Button>
          )}
        </div>

        {/* [VERIFY-P1.6-A] operator-data framing — verbatim disclaimer */}
        <p className="text-[11px] text-slate-400">
          Files are stored as uploaded — never scanned, parsed, or interpreted. Category
          labels are free-text tags the operator sets, not a verified classification.
        </p>

        {/* ── Loading ──────────────────────────────────────────────────────── */}
        {loading && (
          <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading documents">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        )}

        {/* ── Non-fatal load error ─────────────────────────────────────────── */}
        {!loading && loadError && (
          <Alert role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="text-sm">
              Could not load documents. Refresh to try again.
            </AlertDescription>
          </Alert>
        )}

        {/* ── "storage not enabled" (typed refusal, never a crash) ──────────── */}
        {notConfigured && (
          <Alert role="alert">
            <FileWarning className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="text-sm">
              File storage is not enabled by your operator.
            </AlertDescription>
          </Alert>
        )}

        {/* ── Empty state ───────────────────────────────────────────────────── */}
        {!loading && !loadError && documents !== null && documents.length === 0 && (
          <p className="text-sm text-slate-400 italic">No documents uploaded yet.</p>
        )}

        {/* ── Document list ───────────────────────────────────────────────── */}
        {!loading && !loadError && documents !== null && documents.length > 0 && (
          <div className="space-y-1.5">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-start justify-between gap-2 rounded-md bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-800 truncate">{doc.filename}</span>
                    {doc.category && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                        {doc.category}
                      </Badge>
                    )}
                    <StatusChip status={doc.status} />
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatBytes(doc.sizeBytes)} · {formatDate(doc.createdAt)}
                  </p>
                  {rowErrors[doc.id] && (
                    <p role="alert" className="text-xs text-destructive">
                      {rowErrors[doc.id]}
                    </p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload(doc)}
                    disabled={downloadingIds.has(doc.id) || doc.status !== 'stored'}
                    aria-label={`Download ${doc.filename}`}
                  >
                    {downloadingIds.has(doc.id) ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                  {canManage && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(doc)}
                      aria-label={`Delete ${doc.filename}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          ownerType={ownerType}
          ownerId={ownerId}
          onSuccess={(doc) => setDocuments((prev) => [doc, ...(prev ?? [])])}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleteTarget?.filename}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the document. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteConfirm();
              }}
              disabled={isDeleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
