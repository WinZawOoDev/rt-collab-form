import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { AuthCard } from '@/components/chat/auth-card'
import { Button } from '@/components/ui/button'
import {
  clearAuthToken,
  getCurrentUser,
  hydrateAuthToken,
  login,
} from '@/lib/chat-api'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const token = hydrateAuthToken()
    if (!token) {
      return
    }

    try {
      await getCurrentUser()
      throw redirect({ to: '/chat' })
    } catch {
      clearAuthToken()
    }
  },
  component: App,
})

function App() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [authError, setAuthError] = useState('')

  const canLogin = email.trim().length > 0 && password.trim().length > 0
  const currentName = useMemo(() => displayName.trim() || 'You', [displayName])

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canLogin) {
      return
    }

    try {
      setAuthError('')
      await login(email.trim(), currentName)
      await navigate({ to: '/chat' })
    } catch {
      setAuthError('Login failed. Make sure server is running on http://localhost:4000.')
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10 md:px-8">
      <main className="mx-auto w-full max-w-md">
        <AuthCard
          isAuthenticated={false}
          displayName={displayName}
          email={email}
          password={password}
          canLogin={canLogin}
          currentName={currentName}
          onDisplayNameChange={setDisplayName}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={handleAuthSubmit}
          onLogout={() => {}}
        />
        <div className="mt-3 flex justify-center">
          <Button asChild variant="link">
            <Link to="/chat">Go to Chat</Link>
          </Button>
        </div>
      </main>
      {authError ? <p className="mx-auto mt-4 w-full max-w-6xl text-sm text-destructive">{authError}</p> : null}
    </div>
  )
}
