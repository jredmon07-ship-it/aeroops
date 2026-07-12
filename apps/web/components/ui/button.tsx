/**
 * Button — hand-rolled shadcn/ui-compatible button component.
 * Supports variant: default | destructive | outline | ghost | link
 * and size: default | sm | lg | icon.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-brand text-white shadow-sm hover:bg-brand-ink active:translate-y-px focus-visible:ring-brand dark:hover:bg-blue-500',
        // dark: the danger token is brightened for chips, so pin the solid fill
        // to a darker red that keeps white-text AA in dark mode.
        destructive:
          'bg-danger text-white shadow-sm hover:bg-red-700 active:translate-y-px focus-visible:ring-danger dark:bg-red-600 dark:hover:bg-red-500',
        outline:
          'border border-slate-300 bg-white shadow-xs hover:bg-slate-50 hover:border-slate-400 text-slate-900 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:border-slate-600',
        ghost:
          'hover:bg-slate-100 text-slate-700 hover:text-slate-900 focus-visible:ring-slate-400 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        link: 'text-brand underline-offset-4 hover:underline focus-visible:ring-brand dark:text-sky-400',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Busy state: shows a centered spinner, disables the button, and sets
   * aria-busy — while preserving the button's width (the label stays in the
   * layout, invisible). Ignored when asChild (Slot has no busy semantics).
   */
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, isLoading = false, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    if (asChild || !isLoading) {
      return (
        <Comp
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          disabled={disabled}
          {...props}
        >
          {children}
        </Comp>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), 'relative')}
        ref={ref}
        disabled
        aria-busy="true"
        {...props}
      >
        <span
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
        {/* Invisible label preserves the button's width while loading. */}
        <span className="invisible inline-flex items-center gap-2">{children}</span>
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
