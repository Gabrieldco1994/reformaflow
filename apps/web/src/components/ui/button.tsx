'use client';

import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    const variants = {
      primary: 'bg-darc-red text-darc-linen hover:bg-darc-red-pastel hover:text-darc-velvet shadow-darc-soft',
      secondary: 'bg-darc-velvet text-darc-pink-logo hover:bg-darc-red-bright hover:text-darc-linen',
      danger: 'bg-darc-pink text-darc-linen hover:bg-darc-red-pastel hover:text-darc-velvet',
      ghost: 'bg-transparent text-darc-red border border-transparent hover:bg-darc-red-pastel/30 hover:border-darc-red-pastel',
    };
    const sizes = {
      sm: 'px-3 py-1.5 text-xs',
      md: 'px-4 py-2 text-sm',
      lg: 'px-5 py-2.5 text-base',
    };

    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
