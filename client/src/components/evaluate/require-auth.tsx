import type { ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type RequireAuthProps = {
  isAuthenticated: boolean
  children: ReactNode
}

export function RequireAuth({ isAuthenticated, children }: RequireAuthProps) {
  if (!isAuthenticated) {
    return (
      <Card className="h-[70vh]">
        <CardHeader>
          <CardTitle>Team Evaluation</CardTitle>
          <CardDescription>Message list and evaluation form are protected.</CardDescription>
        </CardHeader>
        <CardContent className="flex h-full items-center justify-center">
          <p className="text-muted-foreground text-sm">Sign in first to access the evaluation room.</p>
        </CardContent>
      </Card>
    )
  }

  return <>{children}</>
}
