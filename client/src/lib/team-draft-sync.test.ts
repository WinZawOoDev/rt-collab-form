import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { ApiConflictError } from './evaluate-api'
import { decodeBase64, encodeBase64, TeamDraftSync, type TeamDraftSyncApi } from './team-draft-sync'

function createServer() {
    const doc = new Y.Doc()
    doc.get('root', Y.XmlText)
    return doc
}

function createApi(serverDoc: Y.Doc, revisionHolder: { value: number }): TeamDraftSyncApi {
    return {
        getState: async () => ({
            state: encodeBase64(Y.encodeStateAsUpdate(serverDoc)),
            revision: revisionHolder.value,
        }),
        save: async (update, baseRevision) => {
            if (baseRevision !== revisionHolder.value) {
                throw new ApiConflictError({
                    state: encodeBase64(Y.encodeStateAsUpdate(serverDoc)),
                    revision: revisionHolder.value,
                })
            }
            Y.applyUpdate(serverDoc, decodeBase64(update))
            revisionHolder.value += 1
            return revisionHolder.value
        },
        isUnauthorized: () => false,
    }
}

function getText(doc: Y.Doc) {
    return doc.get('root', Y.XmlText).toString()
}

function appendText(doc: Y.Doc, text: string) {
    const root = doc.get('root', Y.XmlText)
    root.insert(root.length, text)
}

describe('TeamDraftSync', () => {
    it('initializes from server state', async () => {
        const serverDoc = createServer()
        appendText(serverDoc, 'server content')
        const revisionHolder = { value: 0 }

        const clientDoc = new Y.Doc()
        const sync = new TeamDraftSync(clientDoc, createApi(serverDoc, revisionHolder))
        await sync.initialize()

        expect(sync.isInitialized).toBe(true)
        expect(sync.getRevision()).toBe(0)
        expect(getText(clientDoc)).toBe('server content')
        sync.destroy()
    })

    it('applies remote updates in order', async () => {
        const serverDoc = createServer()
        const revisionHolder = { value: 0 }
        const api = createApi(serverDoc, revisionHolder)

        const clientDoc = new Y.Doc()
        const sync = new TeamDraftSync(clientDoc, api)
        await sync.initialize()

        const otherDoc = new Y.Doc()
        Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(serverDoc))
        appendText(otherDoc, 'from other client')
        const update = Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(serverDoc))

        await api.save(encodeBase64(update), revisionHolder.value)
        await sync.handleRemoteUpdate(encodeBase64(update), revisionHolder.value)

        expect(sync.getRevision()).toBe(1)
        expect(getText(clientDoc)).toBe('from other client')
        sync.destroy()
    })

    it('refetches when a remote update arrives with a revision gap', async () => {
        const serverDoc = createServer()
        const revisionHolder = { value: 0 }
        const api = createApi(serverDoc, revisionHolder)

        const clientDoc = new Y.Doc()
        const sync = new TeamDraftSync(clientDoc, api)
        await sync.initialize()

        appendText(serverDoc, 'missed update')
        revisionHolder.value = 1

        const otherDoc = new Y.Doc()
        Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(serverDoc))
        appendText(otherDoc, ' plus latest')
        const update = Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(serverDoc))
        await api.save(encodeBase64(update), 1)

        await sync.handleRemoteUpdate(encodeBase64(update), 2)

        expect(sync.getRevision()).toBe(2)
        expect(getText(clientDoc)).toBe('missed update plus latest')
        sync.destroy()
    })

    it('sends local edits to the server', async () => {
        const serverDoc = createServer()
        const revisionHolder = { value: 0 }
        const api = createApi(serverDoc, revisionHolder)

        const clientDoc = new Y.Doc()
        const sync = new TeamDraftSync(clientDoc, api)
        await sync.initialize()

        appendText(clientDoc, 'typed locally')
        await sync.flush()

        expect(revisionHolder.value).toBe(1)
        expect(getText(serverDoc)).toBe('typed locally')
        sync.destroy()
    })

    it('reconciles concurrent edits from two clients', async () => {
        const serverDoc = createServer()
        const revisionHolder = { value: 0 }
        const api = createApi(serverDoc, revisionHolder)

        const clientA = new Y.Doc()
        const syncA = new TeamDraftSync(clientA, api)
        await syncA.initialize()

        const clientB = new Y.Doc()
        const syncB = new TeamDraftSync(clientB, api)
        await syncB.initialize()

        appendText(clientA, 'hello from A ')
        appendText(clientB, 'hello from B ')

        await syncA.flush()
        await syncB.flush()

        const merged = getText(serverDoc)
        expect(merged).toContain('hello from A')
        expect(merged).toContain('hello from B')

        const finalUpdate = encodeBase64(Y.encodeStateAsUpdate(serverDoc))
        await syncA.handleRemoteUpdate(finalUpdate, 2)
        await syncB.handleRemoteUpdate(finalUpdate, 2)

        expect(getText(clientA)).toBe(getText(serverDoc))
        expect(getText(clientB)).toBe(getText(serverDoc))

        syncA.destroy()
        syncB.destroy()
    })
})
