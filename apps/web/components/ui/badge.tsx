/**
 * Badge — hand-rolled shadcn/ui-compatible badge component.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-brand/10 text-brand-ink',
        secondary:
          'border-slate-200 bg-slate-100 text-slate-600',
        destructive:
          'border-transparent bg-danger/10 text-danger',
        outline: 'text-slate-700 border-slate-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
