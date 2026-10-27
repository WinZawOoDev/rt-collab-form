import * as Y from 'yjs'

import { createDraftSaveQueue, type DraftSaveQueue } from '@/lib/draft-save-queue'
import {
    ApiConflictError,
    ApiUnauthorizedError,
    getTeamDraft,
    saveTeamDraftUpdate,
} from '@/lib/evaluate-api'
import type { TeamDraftState } from '@shared/index'

export const REMOTE_UPDATE_ORIGIN = 'remote-sse'

export type TeamDraftSyncApi = {
    getState: () => Promise<TeamDraftState>
    save: (update: string, baseRevision: number) => Promise<number>
    isUnauthorized: (error: unknown) => boolean
}

export type TeamDraftSyncHandlers = {
    onUnauthorized: () => void
    onLocalEdit: () => void
}

export function encodeBase64(bytes: Uint8Array) {
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
}

export function decodeBase64(encoded: string): Uint8Array {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function createDefaultApi(): TeamDraftSyncApi {
    return {
        getState: () => getTeamDraft(),
        save: (update, baseRevision) => saveTeamDraftUpdate(update, baseRevision),
        isUnauthorized: (error) => error instanceof ApiUnauthorizedError,
    }
}

export class TeamDraftSync {
    private doc: Y.Doc
    private serverDoc: Y.Doc
    private api: TeamDraftSyncApi
    private queue: DraftSaveQueue
    private handlers: TeamDraftSyncHandlers | null = null
    private unsubscribeDoc: (() => void) | null = null
    private initialized = false

    constructor(doc: Y.Doc, api: TeamDraftSyncApi = createDefaultApi()) {
        this.doc = doc
        this.serverDoc = new Y.Doc()
        this.api = api

        this.queue = createDraftSaveQueue({
            getPayload: () => {
                const update = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.serverDoc))
                return update.length > 2 ? encodeBase64(update) : null
            },
            save: (payload, baseRevision) => this.api.save(payload, baseRevision),
            isConflict: (error) => {
                if (error instanceof ApiConflictError) {
                    return { state: error.state.state, revision: error.state.revision }
                }
                return null
            },
            onConflict: async (conflict) => {
                await this.replaceServerState(conflict.state, conflict.revision)
            },
            onSaved: (_revision, payload) => {
                try {
                    Y.applyUpdate(this.serverDoc, decodeBase64(payload))
                } catch {
                }
            },
        })
    }

    setHandlers(handlers: TeamDraftSyncHandlers) {
        this.handlers = handlers
    }

    getRevision() {
        return this.queue.getRevision()
    }

    get isInitialized() {
        return this.initialized
    }

    private applyUpdateToDoc(update: Uint8Array, origin: unknown) {
        try {
            Y.applyUpdate(this.doc, update, origin)
            return true
        } catch {
            return false
        }
    }

    private async replaceServerState(state: string, revision: number) {
        try {
            const decoded = decodeBase64(state)
            const freshServerDoc = new Y.Doc()
            Y.applyUpdate(freshServerDoc, decoded)
            if (!this.applyUpdateToDoc(decoded, REMOTE_UPDATE_ORIGIN)) {
                return
            }
            this.serverDoc = freshServerDoc
            this.queue.setRevision(revision)
        } catch {
        }
    }

    private async refetch() {
        try {
            const { state, revision } = await this.api.getState()
            await this.replaceServerState(state, revision)
            this.queue.enqueue()
        } catch (error) {
            if (this.api.isUnauthorized(error)) {
                this.handlers?.onUnauthorized()
            }
        }
    }

    async initialize() {
        if (this.initialized) {
            return
        }

        try {
            const { state, revision } = await this.api.getState()
            await this.replaceServerState(state, revision)
            this.initialized = true

            const handler = (_update: Uint8Array, origin: unknown) => {
                if (origin === REMOTE_UPDATE_ORIGIN) {
                    return
                }
                this.handlers?.onLocalEdit()
                this.queue.enqueue()
            }
            this.doc.on('update', handler)
            this.unsubscribeDoc = () => {
                this.doc.off('update', handler)
            }
        } catch (error) {
            if (this.api.isUnauthorized(error)) {
                this.handlers?.onUnauthorized()
            }
        }
    }

    async handleRemoteUpdate(update: string, revision: number) {
        if (!this.initialized) {
            return
        }

        const lastKnown = this.queue.getRevision()
        if (revision <= lastKnown) {
            return
        }

        if (revision !== lastKnown + 1) {
            await this.refetch()
            return
        }

        try {
            const decoded = decodeBase64(update)
            if (!this.applyUpdateToDoc(decoded, REMOTE_UPDATE_ORIGIN)) {
                await this.refetch()
                return
            }
            Y.applyUpdate(this.serverDoc, decoded)
            this.queue.setRevision(revision)
        } catch {
            await this.refetch()
        }
    }

    async refresh() {
        if (!this.initialized) {
            return
        }
        await this.refetch()
    }

    async flush() {
        await this.queue.flush()
    }

    destroy() {
        this.unsubscribeDoc?.()
        this.queue.dispose()
        this.doc.destroy()
    }
}
