import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { AuthCard } from '@/components/chat/auth-card'
import { ChatPanel } from '@/components/chat/chat-panel'
import { RequireAuth } from '@/components/chat/require-auth'
import type { Message } from '@/components/chat/types'
import {
  ApiUnauthorizedError,
  clearAuthToken,
  getCurrentUser,
  getMessages,
  getMessagesStreamUrl,
  hydrateAuthToken,
  login,
  sendMessage,
} from '@/lib/chat-api'
import type { ApiMessage } from '@/lib/chat-api'

export const Route = createFileRoute('/')({ component: App })

type CurrentUser = {
  id: number
  email: string
  name: string | null
}

function mapTimestamp(value: number) {
  return `#${value}`
}

function mapServerMessage(message: ApiMessage, currentUserId: number): Message {
  return {
    id: message.id,
    author: message.author,
    content: message.content,
    timestamp: mapTimestamp(message.timestamp),
    authorId: message.authorId,
    mine: message.authorId === currentUserId,
  }
}

function mapServerMessages(
  serverMessages: Awaited<ReturnType<typeof getMessages>>,
  currentUserId: number,
): Message[] {
  return serverMessages.map((message) => mapServerMessage(message, currentUserId))
}

function upsertMessage(previous: Message[], next: Message): Message[] {
  const exists = previous.some((message) => message.id === next.id)
  if (!exists) {
    return [...previous, next].sort((a, b) => a.id - b.id)
  }
  return previous.map((message) => (message.id === next.id ? next : message))
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [messageText, setMessageText] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [authError, setAuthError] = useState('')
  const [chatError, setChatError] = useState('')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)

  const canLogin = email.trim().length > 0 && password.trim().length > 0
  const canSend = messageText.trim().length > 0 && isAuthenticated
  const currentName = useMemo(() => displayName.trim() || 'You', [displayName])

  const handleLogout = () => {
    clearAuthToken()
    setIsAuthenticated(false)
    setCurrentUser(null)
    setMessages([])
    setMessageText('')
    setChatError('')
  }

  const handleSessionExpired = () => {
    clearAuthToken()
    setIsAuthenticated(false)
    setCurrentUser(null)
    setMessages([])
    setMessageText('')
    setChatError('')
    setAuthError('Your session expired. Please sign in again.')
  }

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canLogin) {
      return
    }

    try {
      setAuthError('')
      setChatError('')
      setIsLoadingMessages(true)

      const user = await login(email.trim(), currentName)
      const serverMessages = await getMessages()

      setCurrentUser(user)
      setMessages(mapServerMessages(serverMessages, user.id))
      setIsAuthenticated(true)
    } catch {
      clearAuthToken()
      setAuthError('Login failed. Make sure server is running on http://localhost:4000.')
      setIsAuthenticated(false)
      setCurrentUser(null)
    } finally {
      setIsLoadingMessages(false)
    }
  }

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend || !currentUser) {
      return
    }

    try {
      setChatError('')
      const created = await sendMessage(messageText.trim())
      const nextMessage: Message = {
        id: created.id,
        author: created.author,
        content: created.content,
        timestamp: mapTimestamp(created.timestamp),
        authorId: created.authorId,
        mine: created.authorId === currentUser.id,
      }
      setMessages((prev) => [...prev, nextMessage])
      setMessageText('')
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        handleSessionExpired()
      } else {
        setChatError('Message could not be sent. Please try again.')
      }
    }
  }

  useEffect(() => {
    let isCancelled = false

    const restoreSession = async () => {
      const storedToken = hydrateAuthToken()
      if (!storedToken) {
        return
      }

      try {
        setAuthError('')
        setIsLoadingMessages(true)

        const user = await getCurrentUser()
        const serverMessages = await getMessages()

        if (isCancelled) {
          return
        }

        setCurrentUser(user)
        setEmail(user.email)
        setDisplayName(user.name ?? '')
        setMessages(mapServerMessages(serverMessages, user.id))
        setIsAuthenticated(true)
      } catch (error) {
        if (!isCancelled) {
          if (error instanceof ApiUnauthorizedError) {
            handleSessionExpired()
          } else {
            clearAuthToken()
            setIsAuthenticated(false)
            setCurrentUser(null)
            setMessages([])
          }
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingMessages(false)
        }
      }
    }

    void restoreSession()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated || !currentUser) {
      return
    }

    let isCancelled = false
    let source: EventSource | null = null
    let reconnectTimeoutId: number | null = null
    let reconnectAttempt = 0

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutId !== null) {
        window.clearTimeout(reconnectTimeoutId)
        reconnectTimeoutId = null
      }
    }

    const scheduleReconnect = () => {
      if (isCancelled) {
        return
      }

      const baseDelay = 1000
      const maxDelay = 30000
      const delay = Math.min(baseDelay * 2 ** reconnectAttempt, maxDelay)
      reconnectAttempt += 1

      clearReconnectTimeout()
      reconnectTimeoutId = window.setTimeout(() => {
        connect()
      }, delay)
    }

    const handleIncomingMessage = (event: MessageEvent<string>) => {
      try {
        const serverMessage = JSON.parse(event.data) as ApiMessage
        const mapped = mapServerMessage(serverMessage, currentUser.id)
        setMessages((previous) => upsertMessage(previous, mapped))
      } catch {
      }
    }

    const handleSseAuthError = () => {
      isCancelled = true
      clearReconnectTimeout()
      source?.removeEventListener('message', handleIncomingMessage)
      source?.removeEventListener('auth-error', handleSseAuthError)
      source?.close()
      source = null
      handleSessionExpired()
    }

    const connect = () => {
      if (isCancelled) {
        return
      }

      let streamUrl = ''
      try {
        streamUrl = getMessagesStreamUrl()
      } catch (error) {
        if (error instanceof ApiUnauthorizedError) {
          handleSessionExpired()
          return
        }
        scheduleReconnect()
        return
      }

      source = new EventSource(streamUrl)

      source.addEventListener('ready', () => {
        reconnectAttempt = 0
      })

      source.addEventListener('message', handleIncomingMessage)
      source.addEventListener('auth-error', handleSseAuthError)

      source.onerror = () => {
        source?.removeEventListener('message', handleIncomingMessage)
        source?.removeEventListener('auth-error', handleSseAuthError)
        source?.close()
        source = null
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      isCancelled = true
      clearReconnectTimeout()
      source?.removeEventListener('message', handleIncomingMessage)
      source?.removeEventListener('auth-error', handleSseAuthError)
      source?.close()
      source = null
    }
  }, [isAuthenticated, currentUser])

  return (
    <div className="min-h-screen bg-background px-4 py-10 md:px-8">
      <main className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[360px_1fr]">
        <AuthCard
          isAuthenticated={isAuthenticated}
          displayName={displayName}
          email={email}
          password={password}
          canLogin={canLogin}
          currentName={currentName}
          onDisplayNameChange={setDisplayName}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={handleAuthSubmit}
          onLogout={handleLogout}
        />

        <RequireAuth isAuthenticated={isAuthenticated}>
          <div className="space-y-3">
            {isLoadingMessages ? (
              <p className="text-muted-foreground text-sm">Loading messages...</p>
            ) : null}
            {chatError ? <p className="text-sm text-destructive">{chatError}</p> : null}
            <ChatPanel
              messages={messages}
              messageText={messageText}
              canSend={canSend}
              onMessageTextChange={setMessageText}
              onSendMessage={handleSendMessage}
            />
          </div>
        </RequireAuth>
      </main>
      {authError ? <p className="mx-auto mt-4 w-full max-w-6xl text-sm text-destructive">{authError}</p> : null}
    </div>
  )
}
