import * as React from 'react'
import { cn } from '@/src/lib/utils'

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn('min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
}
