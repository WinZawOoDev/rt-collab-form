import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthCard, type AuthFormValues } from '@/components/evaluate/auth-card'
import {
  clearAuthToken,
  getCurrentUser,
  hydrateAuthToken,
  login,
} from '@/lib/evaluate-api'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const token = hydrateAuthToken()
    if (!token) {
      return
    }

    try {
      await getCurrentUser()
      throw redirect({ to: '/evaluate' })
    } catch {
      clearAuthToken()
    }
  },
  component: App,
})

function App() {
  const navigate = useNavigate()
  const [authError, setAuthError] = useState('')

  const getLoginName = (value: string) => {
    const emailValue = value.trim().toLowerCase()
    const [localPart] = emailValue.split('@')
    return localPart || 'User'
  }

  const handleAuthSubmit = async (values: AuthFormValues) => {
    try {
      setAuthError('')
      await login(values.email.trim(), getLoginName(values.email))
      await navigate({ to: '/evaluate' })
    } catch {
      setAuthError('Login failed. Make sure server is running on http://localhost:4000.')
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 md:px-8">
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center">
        <AuthCard
          isAuthenticated={false}
          email=""
          password=""
          currentName="You"
          onSubmit={handleAuthSubmit}
          onLogout={() => { }}
        />
        {authError ? <p className="mt-4 text-center text-sm text-destructive">{authError}</p> : null}
      </main>
    </div>
  )
}
