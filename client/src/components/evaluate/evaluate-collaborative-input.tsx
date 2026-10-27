import { useEffect } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
    createYjsBinding,
    syncLexicalUpdateToYjs,
    syncYjsChangesToLexical,
    type Binding,
    type Provider,
    type ProviderAwareness,
    type UserState,
} from '@lexical/yjs'
import { $getRoot, SKIP_COLLAB_TAG, type EditorState } from 'lexical'
import { UndoManager, type Doc, type Transaction, type YEvent } from 'yjs'

import type { TeamDraftSync } from '@/lib/team-draft-sync'

type EvaluateCollaborativeInputProps = {
    doc: Doc
    sync: TeamDraftSync
    onChange: (content: string) => void
    onClearReady: (clear: () => void) => void
}

function createStubProvider(): Provider {
    const awareness: ProviderAwareness = {
        getLocalState: () => null,
        getStates: () => new Map<number, UserState>(),
        off: () => { },
        on: () => { },
        setLocalState: () => { },
        setLocalStateField: () => { },
    }

    return {
        awareness,
        connect: () => { },
        disconnect: () => { },
        off: () => { },
        on: () => { },
    }
}

function CollaborationBinding({ doc, sync }: { doc: Doc; sync: TeamDraftSync }) {
    const [editor] = useLexicalComposerContext()

    useEffect(() => {
        let cancelled = false
        let cleanup: (() => void) | null = null

        void (async () => {
            await sync.initialize()

            for (let attempt = 0; attempt < 5 && !cancelled && !sync.isInitialized; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000))
                await sync.initialize()
            }

            if (cancelled || !sync.isInitialized) {
                return
            }

            const provider = createStubProvider()
            const binding: Binding = createYjsBinding({
                editor,
                id: 'team-draft',
                doc,
                docMap: new Map(),
            })

            const root = binding.root
            const onYjsTreeChanges = (events: Array<YEvent<any>>, transaction: Transaction) => {
                const origin = transaction.origin
                if (origin !== binding) {
                    const isFromUndoManager = origin instanceof UndoManager
                    syncYjsChangesToLexical(binding, provider, events, isFromUndoManager)
                }
            }

            root.getSharedType().observeDeep(onYjsTreeChanges)

            const removeUpdateListener = editor.registerUpdateListener(
                ({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
                    if (!tags.has(SKIP_COLLAB_TAG)) {
                        syncLexicalUpdateToYjs(
                            binding,
                            provider,
                            prevEditorState,
                            editorState,
                            dirtyElements,
                            dirtyLeaves,
                            normalizedNodes,
                            tags,
                        )
                    }
                },
            )

            cleanup = () => {
                root.getSharedType().unobserveDeep(onYjsTreeChanges)
                removeUpdateListener()
            }
        })()

        return () => {
            cancelled = true
            cleanup?.()
        }
    }, [editor, doc, sync])

    return null
}

function ClearEffect({ onClearReady }: { onClearReady: (clear: () => void) => void }) {
    const [editor] = useLexicalComposerContext()

    useEffect(() => {
        onClearReady(() => {
            editor.update(() => {
                $getRoot().clear()
            })
        })
    }, [editor, onClearReady])

    return null
}

export function EvaluateCollaborativeInput({
    doc,
    sync,
    onChange,
    onClearReady,
}: EvaluateCollaborativeInputProps) {
    return (
        <LexicalComposer
            initialConfig={{
                namespace: 'evaluate-team-draft',
                editable: true,
                onError: (error) => {
                    console.error('Lexical editor error:', error)
                },
            }}
        >
            <div className="relative min-h-9 rounded-md border border-input bg-transparent px-3 py-2 text-sm">
                <PlainTextPlugin
                    contentEditable={
                        <ContentEditable
                            className="min-h-5 outline-none"
                            aria-placeholder="Write a shared evaluation..."
                            placeholder={<></>}
                        />
                    }
                    placeholder={
                        <span className="pointer-events-none absolute top-2 left-3 text-muted-foreground text-sm">
                            Write a shared evaluation...
                        </span>
                    }
                    ErrorBoundary={LexicalErrorBoundary}
                />
                <HistoryPlugin />
                <OnChangePlugin
                    onChange={(editorState: EditorState) => {
                        editorState.read(() => {
                            onChange($getRoot().getTextContent())
                        })
                    }}
                />
                <CollaborationBinding doc={doc} sync={sync} />
                <ClearEffect onClearReady={onClearReady} />
            </div>
        </LexicalComposer>
    )
}
