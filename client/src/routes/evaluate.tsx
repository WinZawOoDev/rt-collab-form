import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'

import { EvaluatePanel } from '@/components/evaluate/evaluate-panel'
import type { Message } from '@/components/evaluate/types'
import {
    ApiUnauthorizedError,
    clearAuthToken,
    deleteMessage,
    getCurrentUser,
    getMessages,
    getMessagesStreamUrl,
    hydrateAuthToken,
    sendMessage,
    sendTyping,
    updateMessage,
} from '@/lib/evaluate-api'
import type { ApiMessage } from '@/lib/evaluate-api'
import { mapServerMessage, mapServerMessages, upsertMessage } from '@/lib/messages'
import { TeamDraftSync } from '@/lib/team-draft-sync'

type CurrentUser = {
    id: number
    email: string
    name: string | null
}

type LoaderData = {
    user: CurrentUser
    messages: Awaited<ReturnType<typeof getMessages>>
}

type TypingUser = {
    name: string
    expiresAt: number
}

const TYPING_DISPLAY_MS = 4000
const TYPING_STOP_DELAY_MS = 3000

export const Route = createFileRoute('/evaluate')({
    beforeLoad: async () => {
        const token = hydrateAuthToken()
        if (!token) {
            throw redirect({ to: '/' })
        }
    },
    loader: async () => {
        try {
            const [user, messages] = await Promise.all([getCurrentUser(), getMessages()])
            return { user, messages } satisfies LoaderData
        } catch {
            clearAuthToken()
            throw redirect({ to: '/' })
        }
    },
    component: EvaluatePage,
})

function EvaluatePage() {
    const navigate = useNavigate()
    const loaderData = Route.useLoaderData()

    const [currentUser, setCurrentUser] = useState<CurrentUser>(loaderData.user)
    const [messages, setMessages] = useState<Message[]>(
        mapServerMessages(loaderData.messages, loaderData.user.id),
    )
    const [typingUsers, setTypingUsers] = useState<Record<number, TypingUser>>({})

    const doc = useMemo(() => new Y.Doc(), [])
    const sync = useMemo(() => new TeamDraftSync(doc), [doc])

    const typingDisplayTimeoutsRef = useRef<Record<number, number>>({})

    const handleSessionExpired = () => {
        clearAuthToken()
        setCurrentUser(loaderData.user)
        setMessages([])
        void navigate({ to: '/' })
    }

    const handleSessionExpiredRef = useRef(handleSessionExpired)
    handleSessionExpiredRef.current = handleSessionExpired

    useEffect(() => {
        let typingSent = false
        let typingStopTimeoutId: number | null = null

        sync.setHandlers({
            onUnauthorized: () => {
                handleSessionExpiredRef.current()
            },
            onLocalEdit: () => {
                if (!typingSent) {
                    typingSent = true
                    void sendTyping(true).catch(() => { })
                }

                if (typingStopTimeoutId !== null) {
                    window.clearTimeout(typingStopTimeoutId)
                }

                typingStopTimeoutId = window.setTimeout(() => {
                    typingSent = false
                    void sendTyping(false).catch(() => { })
                }, TYPING_STOP_DELAY_MS)
            },
        })

        return () => {
            if (typingStopTimeoutId !== null) {
                window.clearTimeout(typingStopTimeoutId)
            }
            sync.destroy()
        }
    }, [sync])

    const clearTypingDisplayTimeout = (userId: number) => {
        const timeoutId = typingDisplayTimeoutsRef.current[userId]
        if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId)
            delete typingDisplayTimeoutsRef.current[userId]
        }
    }

    const removeTypingUser = (userId: number) => {
        clearTypingDisplayTimeout(userId)
        setTypingUsers((previous) => {
            const next = { ...previous }
            delete next[userId]
            return next
        })
    }

    const markTypingUser = (userId: number, name: string) => {
        clearTypingDisplayTimeout(userId)
        setTypingUsers((previous) => ({
            ...previous,
            [userId]: { name, expiresAt: Date.now() + TYPING_DISPLAY_MS },
        }))
        typingDisplayTimeoutsRef.current[userId] = window.setTimeout(() => {
            removeTypingUser(userId)
        }, TYPING_DISPLAY_MS)
    }

    const handleTypingEvent = (userId: number, name: string, isTyping: boolean) => {
        if (isTyping) {
            markTypingUser(userId, name)
        } else {
            removeTypingUser(userId)
        }
    }

    const handleSendMessage = async (content: string): Promise<boolean> => {
        try {
            const created = await sendMessage(content)
            const nextMessage: Message = {
                id: created.id,
                author: created.author,
                content: created.content,
                timestamp: `#${created.timestamp}`,
                authorId: created.authorId,
                mine: created.authorId === currentUser.id,
            }
            setMessages((previous) => upsertMessage(previous, nextMessage))
            return true
        } catch (error) {
            if (error instanceof ApiUnauthorizedError) {
                handleSessionExpired()
            }
            return false
        }
    }

    const handleEditMessage = async (id: number, content: string): Promise<boolean> => {
        try {
            const updated = await updateMessage(id, content)
            setMessages((previous) => upsertMessage(previous, mapServerMessage(updated, currentUser.id)))
            return true
        } catch (error) {
            if (error instanceof ApiUnauthorizedError) {
                handleSessionExpired()
            }
            return false
        }
    }

    const handleDeleteMessage = async (id: number): Promise<boolean> => {
        try {
            await deleteMessage(id)
            setMessages((previous) => previous.filter((message) => message.id !== id))
            return true
        } catch (error) {
            if (error instanceof ApiUnauthorizedError) {
                handleSessionExpired()
            }
            return false
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

        const handleIncomingMessageDelete = (event: MessageEvent<string>) => {
            try {
                const deleted = JSON.parse(event.data) as { id: number }
                setMessages((previous) => previous.filter((message) => message.id !== deleted.id))
            } catch {
            }
        }

        const handleIncomingTyping = (event: MessageEvent<string>) => {
            try {
                const typing = JSON.parse(event.data) as { userId: number; name: string; isTyping: boolean }
                handleTypingEvent(typing.userId, typing.name, typing.isTyping)
            } catch {
            }
        }

        const handleIncomingDraftUpdate = (event: MessageEvent<string>) => {
            try {
                const draft = JSON.parse(event.data) as { update: string; revision: number }
                void sync.handleRemoteUpdate(draft.update, draft.revision)
            } catch {
            }
        }

        const handleReady = () => {
            reconnectAttempt = 0
            void sync.refresh()
        }

        const handleSseAuthError = () => {
            isCancelled = true
            clearReconnectTimeout()
            removeAllListeners()
            source?.close()
            source = null
            handleSessionExpired()
        }

        const removeAllListeners = () => {
            source?.removeEventListener('ready', handleReady)
            source?.removeEventListener('message', handleIncomingMessage)
            source?.removeEventListener('message-update', handleIncomingMessage)
            source?.removeEventListener('message-delete', handleIncomingMessageDelete)
            source?.removeEventListener('typing', handleIncomingTyping)
            source?.removeEventListener('draft-update', handleIncomingDraftUpdate)
            source?.removeEventListener('auth-error', handleSseAuthError)
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

            source.addEventListener('ready', handleReady)
            source.addEventListener('message', handleIncomingMessage)
            source.addEventListener('message-update', handleIncomingMessage)
            source.addEventListener('message-delete', handleIncomingMessageDelete)
            source.addEventListener('typing', handleIncomingTyping)
            source.addEventListener('draft-update', handleIncomingDraftUpdate)
            source.addEventListener('auth-error', handleSseAuthError)

            source.onerror = () => {
                removeAllListeners()
                source?.close()
                source = null
                scheduleReconnect()
            }
        }

        connect()

        return () => {
            isCancelled = true
            clearReconnectTimeout()
            removeAllListeners()
            source?.close()
            source = null
        }
    }, [currentUser.id, sync])

    const typingNames = Object.values(typingUsers)
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map((typingUser) => typingUser.name)

    return (
        <div className="min-h-screen bg-background px-4 py-10 md:px-8">
            <main className="mx-auto w-full max-w-5xl space-y-3">
                <EvaluatePanel
                    messages={messages}
                    typingUsers={typingNames}
                    doc={doc}
                    sync={sync}
                    onSendMessage={handleSendMessage}
                    onEditMessage={handleEditMessage}
                    onDeleteMessage={handleDeleteMessage}
                />
            </main>
        </div>
    )
}
