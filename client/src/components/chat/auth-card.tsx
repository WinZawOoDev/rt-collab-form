import type { FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type AuthCardProps = {
  isAuthenticated: boolean
  displayName: string
  email: string
  password: string
  canLogin: boolean
  currentName: string
  onDisplayNameChange: (value: string) => void
  onEmailChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onLogout: () => void
}

export function AuthCard({
  isAuthenticated,
  displayName,
  email,
  password,
  canLogin,
  currentName,
  onDisplayNameChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onLogout,
}: AuthCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authentication</CardTitle>
        <CardDescription>Sign in to start chatting with your team.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="display-name">Display Name</Label>
            <Input
              id="display-name"
              placeholder="Your name"
              value={displayName}
              onChange={(event) => onDisplayNameChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
            />
          </div>
          <Button className="w-full" type="submit" disabled={!canLogin || isAuthenticated}>
            {isAuthenticated ? 'Authenticated' : 'Sign In'}
          </Button>
          {isAuthenticated ? (
            <Button className="w-full" type="button" variant="secondary" onClick={onLogout}>
              Logout
            </Button>
          ) : null}
        </form>
      </CardContent>
      <CardFooter>
        <p className="text-muted-foreground text-xs">
          {isAuthenticated
            ? `Signed in as ${currentName}.`
            : 'Use any credentials to preview the chat UI.'}
        </p>
      </CardFooter>
    </Card>
  )
}
