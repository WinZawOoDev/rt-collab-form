import { describe, expect, it } from 'vitest'

import type { ApiMessage } from '@shared/index'

import { mapServerMessage, mapServerMessages, mapTimestamp, upsertMessage } from './messages'

function makeApiMessage(overrides: Partial<ApiMessage> = {}): ApiMessage {
    return {
        id: 1,
        author: 'Alice',
        content: 'hello',
        timestamp: 1,
        authorId: 10,
        ...overrides,
    }
}

describe('messages', () => {
    it('maps timestamps to a label', () => {
        expect(mapTimestamp(42)).toBe('#42')
    })

    it('marks own messages as mine', () => {
        const mapped = mapServerMessage(makeApiMessage({ authorId: 10 }), 10)
        expect(mapped.mine).toBe(true)
        expect(mapped.author).toBe('Alice')
        expect(mapped.content).toBe('hello')
        expect(mapped.timestamp).toBe('#1')
    })

    it('marks other users messages as not mine', () => {
        const mapped = mapServerMessage(makeApiMessage({ authorId: 11 }), 10)
        expect(mapped.mine).toBe(false)
    })

    it('maps a list of server messages', () => {
        const mapped = mapServerMessages(
            [makeApiMessage({ id: 1 }), makeApiMessage({ id: 2, author: 'Bob' })],
            10,
        )
        expect(mapped).toHaveLength(2)
        expect(mapped[1].author).toBe('Bob')
    })

    it('appends new messages sorted by id', () => {
        const previous = mapServerMessages([makeApiMessage({ id: 1 })], 10)
        const next = mapServerMessage(makeApiMessage({ id: 3, content: 'new' }), 10)
        const result = upsertMessage(previous, next)
        expect(result.map((message) => message.id)).toEqual([1, 3])
    })

    it('replaces an existing message by id', () => {
        const previous = mapServerMessages(
            [makeApiMessage({ id: 1 }), makeApiMessage({ id: 2, content: 'old' })],
            10,
        )
        const updated = mapServerMessage(makeApiMessage({ id: 2, content: 'new' }), 10)
        const result = upsertMessage(previous, updated)
        expect(result).toHaveLength(2)
        expect(result.find((message) => message.id === 2)?.content).toBe('new')
    })
})
