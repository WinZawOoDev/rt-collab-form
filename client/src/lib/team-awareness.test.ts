import { describe, expect, it, vi } from 'vitest'

import type { UserState } from '@lexical/yjs'

import {
    createAwarenessClientId,
    createAwarenessTransport,
    TeamAwareness,
} from './team-awareness'

function makeState(overrides: Partial<UserState> = {}): UserState {
    return {
        anchorPos: null,
        focusPos: null,
        name: 'Alice',
        color: '#f97316',
        focusing: false,
        awarenessData: {},
        ...overrides,
    }
}

describe('TeamAwareness', () => {
    it('tracks local state', () => {
        const awareness = new TeamAwareness(100)
        expect(awareness.getLocalState()).toBeNull()

        awareness.setLocalState(makeState())

        expect(awareness.getLocalState()?.name).toBe('Alice')
        expect(awareness.getStates().get(100)?.name).toBe('Alice')
    })

    it('updates local state fields', () => {
        const awareness = new TeamAwareness(100)
        awareness.setLocalState(makeState())

        awareness.setLocalStateField('focusing', true)

        expect(awareness.getLocalState()?.focusing).toBe(true)
    })

    it('adds and removes remote states', () => {
        const awareness = new TeamAwareness(100)
        const listener = vi.fn()
        awareness.on('update', listener)

        awareness.setRemoteState(7, makeState({ name: 'Bob' }))
        expect(awareness.getStates().get(7)?.name).toBe('Bob')
        expect(listener).toHaveBeenCalledTimes(1)

        awareness.setRemoteState(7, null)
        expect(awareness.getStates().has(7)).toBe(false)
        expect(listener).toHaveBeenCalledTimes(2)

        awareness.off('update', listener)
        awareness.setRemoteState(8, makeState({ name: 'Cara' }))
        expect(listener).toHaveBeenCalledTimes(2)
    })

    it('generates client ids outside the small user id range', () => {
        const id = createAwarenessClientId()
        expect(id).toBeGreaterThanOrEqual(0x40000000)
    })
})

describe('createAwarenessTransport', () => {
    it('sends the latest local state on update', async () => {
        vi.useFakeTimers()
        try {
            const awareness = new TeamAwareness(100)
            const send = vi.fn(async (_state: UserState | null) => { })
            const transport = createAwarenessTransport(awareness, send, 80)

            awareness.setLocalState(makeState())
            awareness.setLocalState(makeState({ focusing: true }))

            await vi.runAllTimersAsync()

            expect(send).toHaveBeenCalledTimes(1)
            expect(send.mock.calls[0][0]?.focusing).toBe(true)

            transport.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('announces departure on dispose', () => {
        const awareness = new TeamAwareness(100)
        const send = vi.fn(async () => { })
        const transport = createAwarenessTransport(awareness, send, 80)

        awareness.setLocalState(makeState())
        transport.dispose()

        expect(send).toHaveBeenCalledWith(null)
    })
})
