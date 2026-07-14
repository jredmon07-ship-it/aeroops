/**
 * components/ui/avatar-upload.tsx — the shared avatar upload control
 * (Slice AVATARS).
 *
 * A small reusable control that sits next to a <UserAvatar>: a hidden file
 * input, client-side downscale-to-256px + re-encode (keeps the data-URI well
 * under the server's AVATAR_MAX_CHARS cap), and a "Remove photo" action when
 * a photo is already set. Every mutation reports back through `onSave` and
 * this component owns the busy state + the toast-on-mutation feedback.
 *
 * The caller (a page-scoped client component) supplies `onSave`, which wraps
 * the actual server action (setMyAvatarAction / updateMemberAvatarAction) and
 * normalizes its result to { ok, message? } — this component never imports a
 * server action directly, so it stays reusable across the People detail page
 * (staff editing a member's photo) and the portal (self-service).
 *
 * Downscale pipeline: draw the picked image onto a canvas whose longest side
 * is capped at 256px, then encode as WEBP (falls back to JPEG when the
 * browser's canvas doesn't support WEBP encoding). A final client-side length
 * check mirrors the server's AVATAR_MAX_CHARS cap so an oversized image never
 * round-trips to the server only to be rejected.
 */
'use client';

import * as React from 'react';
import { Camera, Loader2, X } from 'lucide-react';
import { Button } from './button';
import { toast } from '@/lib/toast-store';

// BOUNDARY: this is a 'use client' component — it must NEVER import a runtime
// value from '@aeroops/api' (that barrel pulls in server-only modules like
// @aeroops/db and node:crypto, which would leak into the client bundle).
// AVATAR_MAX_CHARS is mirrored here as a literal; it must stay in sync with
// the server constant of the same name in packages/api/src/people/avatar.ts.
const AVATAR_MAX_CHARS = 160_000;

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SIDE_PX = 256;
const ENCODE_QUALITY = 0.85;

export interface AvatarSaveResult {
  ok: boolean;
  message?: string;
}

export interface AvatarUploadProps {
  /** Display name — used for the accessible label on the file input. */
  name: string;
  /** The current photo (drives whether "Remove photo" is shown). */
  currentSrc: string | null | undefined;
  /** Persists (or clears, when null) the photo. Resolves to a typed outcome. */
  onSave: (dataUrl: string | null) => Promise<AvatarSaveResult>;
  className?: string;
}

/** Loads a File into an <img>, downscales onto a canvas, returns a data URI. */
function downscaleToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, MAX_SIDE_PX / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 2d context unavailable'));
        return;
      }
      // Fill white FIRST so a transparent PNG does not composite to black when
      // the encoder is a non-alpha format (JPEG, and WEBP on the Safari
      // fallback). A transparent avatar reads as a solid white circle, not a
      // black one.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      let dataUrl = canvas.toDataURL('image/webp', ENCODE_QUALITY);
      // Some browsers silently fall back to PNG when WEBP encoding isn't
      // supported — detect that and re-encode as JPEG instead (also smaller
      // than PNG, keeping us well under AVATAR_MAX_CHARS).
      if (!dataUrl.startsWith('data:image/webp')) {
        dataUrl = canvas.toDataURL('image/jpeg', ENCODE_QUALITY);
      }
      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('image failed to load'));
    };
    img.src = objectUrl;
  });
}

export function AvatarUpload({ name, currentSrc, onSave, className }: AvatarUploadProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [pending, setPending] = React.useState<'upload' | 'remove' | null>(null);
  const busy = pending !== null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error('Choose a PNG, JPEG, or WEBP image.');
      return;
    }

    setPending('upload');
    try {
      const dataUrl = await downscaleToDataUrl(file);
      if (dataUrl.length > AVATAR_MAX_CHARS) {
        toast.error('That image is too large. Try a smaller one.');
        return;
      }
      const result = await onSave(dataUrl);
      if (!result.ok) {
        toast.error(result.message ?? 'Could not save your photo. Please try again.');
        return;
      }
      toast.success('Photo updated.');
    } catch {
      toast.error('Could not process that image. Please try a different one.');
    } finally {
      setPending(null);
    }
  }

  async function handleRemove() {
    setPending('remove');
    try {
      const result = await onSave(null);
      if (!result.ok) {
        toast.error(result.message ?? 'Could not remove your photo. Please try again.');
        return;
      }
      toast.success('Photo removed.');
    } catch {
      toast.error('Could not remove your photo. Please try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={['flex items-center gap-2', className ?? ''].join(' ')}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        onChange={handleFileChange}
        disabled={busy}
        aria-label={`Upload a photo for ${name}`}
        className="sr-only"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {pending === 'upload' ? (
          <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
        ) : (
          <Camera className="h-4 w-4 mr-1" aria-hidden="true" />
        )}
        {currentSrc ? 'Change photo' : 'Upload photo'}
      </Button>
      {currentSrc && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={handleRemove}
          className="text-slate-500 hover:text-destructive dark:text-slate-400"
        >
          {pending === 'remove' ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
          ) : (
            <X className="h-4 w-4 mr-1" aria-hidden="true" />
          )}
          Remove photo
        </Button>
      )}
    </div>
  );
}
