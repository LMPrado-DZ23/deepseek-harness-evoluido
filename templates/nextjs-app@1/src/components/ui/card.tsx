import * as React from 'react'
import { cn } from '@/src/lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'section'>) { return <section className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)} {...props} /> }
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) { return <div className={cn('grid gap-1.5 p-6', className)} {...props} /> }
export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) { return <h2 className={cn('text-xl font-semibold', className)} {...props} /> }
export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) { return <p className={cn('text-sm text-muted-foreground', className)} {...props} /> }
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) { return <div className={cn('p-6 pt-0', className)} {...props} /> }
export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) { return <div className={cn('flex items-center p-6 pt-0', className)} {...props} /> }
