export type DraftConflict = {
    state: string
    revision: number
}

export type DraftSaveQueueOptions = {
    getPayload: () => string | null
    save: (payload: string, baseRevision: number) => Promise<number>
    isConflict: (error: unknown) => DraftConflict | null
    onConflict: (conflict: DraftConflict) => Promise<void>
    onSaved: (revision: number, payload: string) => void
    retries?: number
    retryDelayMs?: number
}

export type DraftSaveQueue = {
    setRevision: (revision: number) => void
    getRevision: () => number
    enqueue: () => Promise<void>
    flush: () => Promise<void>
    dispose: () => void
}

export function createDraftSaveQueue(options: DraftSaveQueueOptions): DraftSaveQueue {
    const maxRetries = options.retries ?? 3
    const retryDelayMs = options.retryDelayMs ?? 2000

    let inFlight = false
    let pendingWhileInFlight = false
    let revision = 0
    let retryCount = 0
    let conflictCount = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const clearRetryTimer = () => {
        if (retryTimer !== null) {
            clearTimeout(retryTimer)
            retryTimer = null
        }
    }

    async function flush(): Promise<void> {
        if (inFlight) {
            pendingWhileInFlight = true
            return
        }

        const payload = options.getPayload()
        if (payload === null) {
            pendingWhileInFlight = false
            return
        }

        inFlight = true
        pendingWhileInFlight = false

        let retry = false
        let delay = 0

        try {
            const savedRevision = await options.save(payload, revision)
            revision = savedRevision
            retryCount = 0
            conflictCount = 0
            options.onSaved(savedRevision, payload)
        } catch (error) {
            const conflict = options.isConflict(error)
            if (conflict) {
                await options.onConflict(conflict)
                revision = conflict.revision
                if (conflictCount < maxRetries) {
                    conflictCount += 1
                    retry = true
                } else {
                    conflictCount = 0
                }
            } else if (retryCount < maxRetries) {
                retryCount += 1
                delay = retryDelayMs
                retry = true
            } else {
                retryCount = 0
            }
        } finally {
            inFlight = false
        }

        if (retry) {
            if (delay > 0) {
                clearRetryTimer()
                retryTimer = setTimeout(() => {
                    retryTimer = null
                    void flush()
                }, delay)
            } else {
                return flush()
            }
            return
        }

        if (pendingWhileInFlight) {
            return flush()
        }
    }

    return {
        setRevision(next: number) {
            revision = next
        },
        getRevision() {
            return revision
        },
        enqueue(): Promise<void> {
            pendingWhileInFlight = true
            clearRetryTimer()
            return flush()
        },
        flush,
        dispose() {
            clearRetryTimer()
        },
    }
}
