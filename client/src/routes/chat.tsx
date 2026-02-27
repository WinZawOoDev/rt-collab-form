import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { ChatPanel } from '@/components/chat/chat-panel'
import type { Message } from '@/components/chat/types'
import { Button } from '@/components/ui/button'
import {
    ApiUnauthorizedError,
    clearAuthToken,
    getCurrentUser,
    getMessages,
    getMessagesStreamUrl,
    hydrateAuthToken,
    sendMessage,
} from '@/lib/chat-api'
import type { ApiMessage } from '@/lib/chat-api'

type CurrentUser = {
    id: number
    email: string
    name: string | null
}

type LoaderData = {
    user: CurrentUser
    messages: Awaited<ReturnType<typeof getMessages>>
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

export const Route = createFileRoute('/chat')({
    beforeLoad: async () => {
        const token = hydrateAuthToken()
        if (!token) {
            throw redirect({ to: '/' })
        }
    },
    loader: async () => {
        try {
            const user = await getCurrentUser()
            const messages = await getMessages()
            return { user, messages } satisfies LoaderData
        } catch {
            clearAuthToken()
            throw redirect({ to: '/' })
        }
    },
    component: ChatPage,
})

function ChatPage() {
    const navigate = useNavigate()
    const loaderData = Route.useLoaderData()

    const [currentUser, setCurrentUser] = useState<CurrentUser>(loaderData.user)
    const [messages, setMessages] = useState<Message[]>(
        mapServerMessages(loaderData.messages, loaderData.user.id),
    )
    const [messageText, setMessageText] = useState('')
    const [chatError, setChatError] = useState('')

    const canSend = messageText.trim().length > 0

    const handleSessionExpired = () => {
        clearAuthToken()
        setCurrentUser(loaderData.user)
        setMessages([])
        setMessageText('')
        setChatError('Your session expired. Please sign in again.')
        void navigate({ to: '/' })
    }

    const handleLogout = () => {
        clearAuthToken()
        void navigate({ to: '/' })
    }

    const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!canSend) {
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
            setMessages((previous) => upsertMessage(previous, nextMessage))
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
    }, [currentUser.id])

    return (
        <div className="min-h-screen bg-background px-4 py-10 md:px-8">
            <main className="mx-auto w-full max-w-5xl space-y-3">
                <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3">
                    <p className="text-sm text-muted-foreground">
                        Signed in as <span className="font-medium text-foreground">{currentUser.name || currentUser.email}</span>
                    </p>
                    <Button type="button" variant="secondary" onClick={handleLogout}>
                        Logout
                    </Button>
                </div>

                {chatError ? <p className="text-sm text-destructive">{chatError}</p> : null}

                <ChatPanel
                    messages={messages}
                    messageText={messageText}
                    canSend={canSend}
                    onMessageTextChange={setMessageText}
                    onSendMessage={handleSendMessage}
                />
            </main>
        </div>
    )
}
