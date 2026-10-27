import type { ApiMessage } from '@shared/index'

import type { Message } from '@/components/evaluate/types'

export function mapTimestamp(value: number) {
    return `#${value}`
}

export function mapServerMessage(message: ApiMessage, currentUserId: number): Message {
    return {
        id: message.id,
        author: message.author,
        content: message.content,
        timestamp: mapTimestamp(message.timestamp),
        authorId: message.authorId,
        mine: message.authorId === currentUserId,
    }
}

export function mapServerMessages(serverMessages: ApiMessage[], currentUserId: number): Message[] {
    return serverMessages.map((message) => mapServerMessage(message, currentUserId))
}

export function upsertMessage(previous: Message[], next: Message): Message[] {
    const exists = previous.some((message) => message.id === next.id)
    if (!exists) {
        return [...previous, next].sort((a, b) => a.id - b.id)
    }
    return previous.map((message) => (message.id === next.id ? next : message))
}
