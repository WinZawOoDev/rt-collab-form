import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { EvaluatePanel } from '@/components/evaluate/evaluate-panel'
import type { Message } from '@/components/evaluate/types'
import {
    ApiConflictError,
    ApiUnauthorizedError,
    clearAuthToken,
    getEvaluationState,
    getCurrentUser,
    getMessages,
    getMessagesStreamUrl,
    hydrateAuthToken,
    saveEvaluationState,
    sendMessage,
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

const BYPASS_CLIENT_ROUTE_AUTH = true
const BYPASS_USER: CurrentUser = {
    id: 0,
    email: 'guest@local',
    name: 'Guest',
}

const BYPASS_EVALUATION_STATE: EvaluationState = {
    content: '',
    lexicalJson: '',
    revision: 0,
}

const MAX_DRAFT_SAVE_RETRIES = 3
const DRAFT_SAVE_RETRY_DELAY_MS = 2000

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
        if (BYPASS_CLIENT_ROUTE_AUTH) {
            return
        }

        const token = hydrateAuthToken()
        if (!token) {
            throw redirect({ to: '/' })
        }
    },
    loader: async () => {
        if (BYPASS_CLIENT_ROUTE_AUTH) {
            return {
                user: BYPASS_USER,
                messages: [],
                evaluationState: BYPASS_EVALUATION_STATE,
            } satisfies LoaderData
        }

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

    const draftRevisionRef = useRef(loaderData.evaluationState.revision)
    const pendingDraftRef = useRef<Omit<EvaluationState, 'revision'> | null>(null)
    const draftSaveInFlightRef = useRef(false)
    const draftRetryCountRef = useRef(0)

    const handleSessionExpired = () => {
        if (BYPASS_CLIENT_ROUTE_AUTH) {
            return
        }

        clearAuthToken()
        setCurrentUser(loaderData.user)
        setMessages([])
        void navigate({ to: '/' })
    }

    const handleSendMessage = async (content: string): Promise<boolean> => {
        if (BYPASS_CLIENT_ROUTE_AUTH) {
            return false
        }

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
        if (BYPASS_CLIENT_ROUTE_AUTH) {
            return
        }

        pendingDraftRef.current = { content, lexicalJson }
        void flushDraftSave()
    }

    useEffect(() => {
        if (BYPASS_CLIENT_ROUTE_AUTH) {
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
    }, [currentUser.id])

    return (
        <div className="min-h-screen bg-background px-4 py-10 md:px-8">
            <main className="mx-auto w-full max-w-5xl space-y-3">
                <EvaluatePanel
                    messages={messages}
                    disableSend={false}
                    initialDraftContent={loaderData.evaluationState.content}
                    initialDraftLexicalJson={loaderData.evaluationState.lexicalJson}
                    onDraftChange={handleDraftChange}
                    onSendMessage={handleSendMessage}
                />
            </main>
        </div>
    )
}
