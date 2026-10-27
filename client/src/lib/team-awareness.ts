import type { ProviderAwareness, UserState } from '@lexical/yjs'

export function createAwarenessClientId() {
    return Math.floor(Math.random() * 0x40000000) + 0x40000000
}

export class TeamAwareness implements ProviderAwareness {
    private clientId: number
    private localState: UserState | null = null
    private states = new Map<number, UserState>()
    private listeners = new Set<() => void>()

    constructor(clientId: number) {
        this.clientId = clientId
    }

    getLocalState(): UserState | null {
        return this.localState
    }

    getStates(): Map<number, UserState> {
        return this.states
    }

    on(_type: 'update', cb: () => void): void {
        this.listeners.add(cb)
    }

    off(_type: 'update', cb: () => void): void {
        this.listeners.delete(cb)
    }

    setLocalState(state: UserState | null): void {
        this.localState = state
        if (state === null) {
            this.states.delete(this.clientId)
        } else {
            this.states.set(this.clientId, state)
        }
        this.emit()
    }

    setLocalStateField(field: string, value: unknown): void {
        this.setLocalState({ ...this.localState, [field]: value } as UserState)
    }

    setRemoteState(clientId: number, state: UserState | null): void {
        if (state === null) {
            this.states.delete(clientId)
        } else {
            this.states.set(clientId, state)
        }
        this.emit()
    }

    private emit() {
        for (const listener of this.listeners) {
            listener()
        }
    }
}

export type AwarenessTransport = {
    dispose: () => void
}

export function createAwarenessTransport(
    awareness: TeamAwareness,
    send: (state: UserState | null) => Promise<void>,
    throttleMs = 80,
): AwarenessTransport {
    let timer: ReturnType<typeof setTimeout> | null = null
    let latestState: UserState | null = awareness.getLocalState()

    const onUpdate = () => {
        latestState = awareness.getLocalState()
        if (timer !== null) {
            return
        }
        timer = setTimeout(() => {
            timer = null
            const state = latestState
            latestState = null
            void send(state).catch(() => { })
        }, throttleMs)
    }

    awareness.on('update', onUpdate)

    return {
        dispose() {
            awareness.off('update', onUpdate)
            if (timer !== null) {
                clearTimeout(timer)
                timer = null
            }
            void send(null).catch(() => { })
        },
    }
}
