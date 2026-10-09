import * as React from 'react'
import { cn } from '@/src/lib/utils'

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} className={cn('h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
}
