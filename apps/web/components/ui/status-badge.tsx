/**
 * StatusBadge — THE one way to render a status/severity chip.
 *
 * Follows the Badge conventions (cva + cn) but uses the app's established
 * "instrument chip" shape — architectural rounded-sm, 10px semibold text —
 * rather than Badge's uppercase pill (which is reserved for role labels).
 *
 * Semantic variants map to the design tokens in globals.css:
 *   success  — green   (Active, Finalized, Completed)
 *   warning  — amber   (Draft, major squawk, due soon)
 *   info     — sky     (informational states)
 *   danger   — red     (Grounded, grounding severity, overdue)
 *   neutral  — slate   (Inactive, Void, minor, unknown)
 *
 * `dot` renders a small leading status dot in the variant color.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border font-semibold leading-4',
  {
    variants: {
      variant: {
        success: 'border-success/25 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        info: 'border-info/25 bg-info/10 text-info',
        danger: 'border-danger/30 bg-danger/10 text-danger',
        neutral: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
      },
      size: {
        sm: 'px-1.5 py-0.5 text-[10px]',
        md: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'sm',
    },
  },
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  /** Render a small leading dot in the variant color. */
  dot?: boolean;
}

function StatusBadge({
  className,
  variant,
  size,
  dot = false,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(statusBadgeVariants({ variant, size }), className)}
      {...props}
    >
      {dot && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export { StatusBadge, statusBadgeVariants };
