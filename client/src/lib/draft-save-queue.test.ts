import { describe, expect, it, vi } from 'vitest'

import { createDraftSaveQueue, type DraftSaveQueueOptions } from './draft-save-queue'

class ConflictError extends Error { }

function createDeferred() {
    let resolve!: (value: number) => void
    const promise = new Promise<number>((r) => {
        resolve = r
    })
    return { promise, resolve }
}

function createHarness(options: Partial<DraftSaveQueueOptions> = {}) {
    const saveCalls: Array<{ payload: string; baseRevision: number }> = []
    const saved: Array<{ revision: number; payload: string }> = []
    const conflicts: Array<{ state: string; revision: number }> = []
    let currentPayload: string | null = null

    const queue = createDraftSaveQueue({
        getPayload: () => currentPayload,
        save: async (payload, baseRevision) => {
            saveCalls.push({ payload, baseRevision })
            return baseRevision + 1
        },
        isConflict: (error) => (error instanceof ConflictError ? { state: 'server-state', revision: 9 } : null),
        onConflict: async (conflict) => {
            conflicts.push(conflict)
        },
        onSaved: (_revision, payload) => {
            saved.push({ revision: _revision, payload })
            if (currentPayload === payload) {
                currentPayload = null
            }
        },
        ...options,
    })

    return {
        queue,
        setPayload: (payload: string | null) => {
            currentPayload = payload
        },
        saveCalls,
        saved,
        conflicts,
    }
}

describe('createDraftSaveQueue', () => {
    it('does nothing when there is no payload', async () => {
        const { queue, saveCalls } = createHarness()
        queue.setRevision(3)

        await queue.flush()

        expect(saveCalls).toHaveLength(0)
    })

    it('saves a pending payload with the current revision', async () => {
        const { queue, setPayload, saveCalls, saved } = createHarness()
        queue.setRevision(4)
        setPayload('update-1')

        await queue.enqueue()

        expect(saveCalls).toEqual([{ payload: 'update-1', baseRevision: 4 }])
        expect(saved).toEqual([{ revision: 5, payload: 'update-1' }])
        expect(queue.getRevision()).toBe(5)
    })

    it('coalesces changes made while a save is in flight', async () => {
        const deferred = createDeferred()
        const { queue, setPayload, saveCalls } = createHarness({
            save: async (payload, baseRevision) => {
                saveCalls.push({ payload, baseRevision })
                await deferred.promise
                return baseRevision + 1
            },
        })
        queue.setRevision(0)
        setPayload('update-1')

        const first = queue.enqueue()
        setPayload('update-2')
        queue.enqueue()
        deferred.resolve(0)
        await first

        expect(saveCalls).toEqual([
            { payload: 'update-1', baseRevision: 0 },
            { payload: 'update-2', baseRevision: 1 },
        ])
        expect(queue.getRevision()).toBe(2)
    })

    it('resolves conflicts by adopting the server revision and re-saving', async () => {
        const { queue, setPayload, saveCalls, conflicts } = createHarness({
            save: async (payload, baseRevision) => {
                saveCalls.push({ payload, baseRevision })
                if (baseRevision !== 9) {
                    throw new ConflictError()
                }
                return baseRevision + 1
            },
            onConflict: async (conflict) => {
                conflicts.push(conflict)
                setPayload('update-1')
            },
        })
        queue.setRevision(3)
        setPayload('update-1')

        await queue.enqueue()

        expect(conflicts).toEqual([{ state: 'server-state', revision: 9 }])
        expect(saveCalls).toEqual([
            { payload: 'update-1', baseRevision: 3 },
            { payload: 'update-1', baseRevision: 9 },
        ])
        expect(queue.getRevision()).toBe(10)
    })

    it('retries transient failures with backoff and gives up after the retry budget', async () => {
        vi.useFakeTimers()
        try {
            const { queue, setPayload, saveCalls } = createHarness({
                retries: 2,
                retryDelayMs: 2000,
                save: async (payload, baseRevision) => {
                    saveCalls.push({ payload, baseRevision })
                    throw new Error('network')
                },
            })
            queue.setRevision(0)
            setPayload('update-1')

            await queue.enqueue()
            await vi.runAllTimersAsync()

            expect(saveCalls).toHaveLength(3)

            setPayload('update-2')
            await queue.enqueue()
            await vi.runAllTimersAsync()

            expect(saveCalls).toHaveLength(6)
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not re-save when the payload has not changed', async () => {
        const { queue, setPayload, saveCalls } = createHarness()
        queue.setRevision(1)
        setPayload('update-1')

        await queue.enqueue()
        await queue.enqueue()

        expect(saveCalls).toHaveLength(1)
    })
})
