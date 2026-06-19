/**
 * Button — hand-rolled shadcn/ui-compatible button component.
 * Supports variant: default | destructive | outline | ghost | link
 * and size: default | sm | lg | icon.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-brand text-white shadow-sm hover:bg-brand-ink active:translate-y-px focus-visible:ring-brand',
        destructive:
          'bg-danger text-white shadow-sm hover:bg-red-700 active:translate-y-px focus-visible:ring-danger',
        outline:
          'border border-slate-300 bg-white shadow-xs hover:bg-slate-50 hover:border-slate-400 text-slate-900 focus-visible:ring-slate-400',
        ghost:
          'hover:bg-slate-100 text-slate-700 hover:text-slate-900 focus-visible:ring-slate-400',
        link: 'text-brand underline-offset-4 hover:underline focus-visible:ring-brand',
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
