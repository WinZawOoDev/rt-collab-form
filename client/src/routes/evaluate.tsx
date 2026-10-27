import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { EvaluatePanel } from '@/components/evaluate/evaluate-panel'
import type { Message } from '@/components/evaluate/types'
import {
    ApiConflictError,
    ApiUnauthorizedError,
    clearAuthToken,
    deleteMessage,
    getEvaluationState,
    getCurrentUser,
    getMessages,
    getMessagesStreamUrl,
    hydrateAuthToken,
    saveEvaluationState,
    sendMessage,
    sendTyping,
    updateMessage,
} from '@/lib/evaluate-api'
import type { ApiMessage, EvaluationState } from '@/lib/evaluate-api'

type CurrentUser = {
    id: number
    email: string
    name: string | null
}

type LoaderData = {
    user: CurrentUser
    messages: Awaited<ReturnType<typeof getMessages>>
    evaluationState: EvaluationState
}

type TypingUser = {
    name: string
    expiresAt: number
}

const MAX_DRAFT_SAVE_RETRIES = 3
const DRAFT_SAVE_RETRY_DELAY_MS = 2000
const TYPING_DISPLAY_MS = 4000
const TYPING_STOP_DELAY_MS = 3000

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

export const Route = createFileRoute('/evaluate')({
    beforeLoad: async () => {
        const token = hydrateAuthToken()
        if (!token) {
            throw redirect({ to: '/' })
        }
    },
    loader: async () => {
        try {
            const [user, messages, evaluationState] = await Promise.all([
                getCurrentUser(),
                getMessages(),
                getEvaluationState(),
            ])
            return { user, messages, evaluationState } satisfies LoaderData
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

    const draftRevisionRef = useRef(loaderData.evaluationState.revision)
    const pendingDraftRef = useRef<Omit<EvaluationState, 'revision'> | null>(null)
    const draftSaveInFlightRef = useRef(false)
    const draftRetryCountRef = useRef(0)

    const typingSentRef = useRef(false)
    const typingStopTimeoutRef = useRef<number | null>(null)
    const typingDisplayTimeoutsRef = useRef<Record<number, number>>({})

    const handleSessionExpired = () => {
        clearAuthToken()
        setCurrentUser(loaderData.user)
        setMessages([])
        void navigate({ to: '/' })
    }

    const handleSendMessage = async (content: string): Promise<boolean> => {
        try {
            const created = await sendMessage(content)
            const nextMessage: Message = {
                id: created.id,
                author: created.author,
                content: created.content,
                timestamp: mapTimestamp(created.timestamp),
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

    const clearTypingStopTimeout = () => {
        if (typingStopTimeoutRef.current !== null) {
            window.clearTimeout(typingStopTimeoutRef.current)
            typingStopTimeoutRef.current = null
        }
    }

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
        if (userId === currentUser.id) {
            return
        }

        if (isTyping) {
            markTypingUser(userId, name)
        } else {
            removeTypingUser(userId)
        }
    }

    const flushDraftSave = async () => {
        if (draftSaveInFlightRef.current) {
            return
        }

        const pending = pendingDraftRef.current
        if (!pending) {
            return
        }

        pendingDraftRef.current = null
        draftSaveInFlightRef.current = true

        let nextPending: Omit<EvaluationState, 'revision'> | null = null
        let retryDelay = 0

        try {
            const saved = await saveEvaluationState(pending, draftRevisionRef.current)
            draftRevisionRef.current = saved.revision
            draftRetryCountRef.current = 0
            nextPending = pendingDraftRef.current
        } catch (error) {
            if (error instanceof ApiUnauthorizedError) {
                pendingDraftRef.current = null
                draftRetryCountRef.current = 0
                handleSessionExpired()
                return
            }

            if (error instanceof ApiConflictError) {
                draftRevisionRef.current = error.state.revision
            } else {
                retryDelay = DRAFT_SAVE_RETRY_DELAY_MS
            }

            if (draftRetryCountRef.current < MAX_DRAFT_SAVE_RETRIES) {
                draftRetryCountRef.current += 1
                nextPending = pendingDraftRef.current ?? pending
            } else {
                pendingDraftRef.current = pendingDraftRef.current ?? pending
                draftRetryCountRef.current = 0
            }
        } finally {
            draftSaveInFlightRef.current = false
        }

        if (!nextPending) {
            return
        }

        pendingDraftRef.current = nextPending
        if (retryDelay > 0) {
            window.setTimeout(() => {
                void flushDraftSave()
            }, retryDelay)
        } else {
            void flushDraftSave()
        }
    }

    const handleDraftChange = async (content: string, lexicalJson: string) => {
        pendingDraftRef.current = { content, lexicalJson }
        void flushDraftSave()

        if (!typingSentRef.current) {
            typingSentRef.current = true
            void sendTyping(true).catch(() => { })
        }

        clearTypingStopTimeout()
        typingStopTimeoutRef.current = window.setTimeout(() => {
            typingSentRef.current = false
            void sendTyping(false).catch(() => { })
        }, TYPING_STOP_DELAY_MS)
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

        const removeAllListeners = () => {
            source?.removeEventListener('message', handleIncomingMessage)
            source?.removeEventListener('message-update', handleIncomingMessage)
            source?.removeEventListener('message-delete', handleIncomingMessageDelete)
            source?.removeEventListener('typing', handleIncomingTyping)
            source?.removeEventListener('auth-error', handleSseAuthError)
        }

        const handleSseAuthError = () => {
            isCancelled = true
            clearReconnectTimeout()
            removeAllListeners()
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
            source.addEventListener('message-update', handleIncomingMessage)
            source.addEventListener('message-delete', handleIncomingMessageDelete)
            source.addEventListener('typing', handleIncomingTyping)
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
    }, [currentUser.id])

    useEffect(() => {
        return () => {
            clearTypingStopTimeout()
        }
    }, [])

    const typingNames = Object.values(typingUsers)
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map((typingUser) => typingUser.name)

    return (
        <div className="min-h-screen bg-background px-4 py-10 md:px-8">
            <main className="mx-auto w-full max-w-5xl space-y-3">
                <EvaluatePanel
                    messages={messages}
                    typingUsers={typingNames}
                    initialDraftContent={loaderData.evaluationState.content}
                    initialDraftLexicalJson={loaderData.evaluationState.lexicalJson}
                    onDraftChange={handleDraftChange}
                    onSendMessage={handleSendMessage}
                    onEditMessage={handleEditMessage}
                    onDeleteMessage={handleDeleteMessage}
                />
            </main>
        </div>
    )
}
