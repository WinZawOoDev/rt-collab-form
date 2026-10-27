import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
    createYjsBinding,
    initLocalState,
    setLocalStateFocus,
    syncCursorPositions,
    syncLexicalUpdateToYjs,
    syncYjsChangesToLexical,
    type Binding,
    type Provider,
} from '@lexical/yjs'
import {
    $getRoot,
    BLUR_COMMAND,
    COMMAND_PRIORITY_EDITOR,
    FOCUS_COMMAND,
    SKIP_COLLAB_TAG,
    type EditorState,
} from 'lexical'
import { UndoManager, type Doc, type Transaction, type YEvent } from 'yjs'

import { TeamAwareness } from '@/lib/team-awareness'
import type { TeamDraftSync } from '@/lib/team-draft-sync'

type EvaluateCollaborativeInputProps = {
    doc: Doc
    sync: TeamDraftSync
    awareness: TeamAwareness
    awarenessName: string
    awarenessColor: string
    onChange: (content: string) => void
    onClearReady: (clear: () => void) => void
}

function createProvider(awareness: TeamAwareness): Provider {
    return {
        awareness,
        connect: () => { },
        disconnect: () => { },
        off: () => { },
        on: () => { },
    }
}

type CollaborationBindingProps = {
    doc: Doc
    sync: TeamDraftSync
    awareness: TeamAwareness
    name: string
    color: string
}

function CursorContainer({ onReady }: { onReady: (element: HTMLDivElement) => void }) {
    const ref = useRef<HTMLDivElement | null>(null)

    return createPortal(
        <div
            ref={(element) => {
                ref.current = element
                if (element) {
                    onReady(element)
                }
            }}
        />,
        document.body,
    )
}

function CollaborationBinding({ doc, sync, awareness, name, color }: CollaborationBindingProps) {
    const [editor] = useLexicalComposerContext()
    const cursorContainerRef = useRef<HTMLDivElement | null>(null)

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

            const provider = createProvider(awareness)
            const binding: Binding = createYjsBinding({
                editor,
                id: 'team-draft',
                doc,
                docMap: new Map(),
            })

            if (cursorContainerRef.current) {
                binding.cursorsContainer = cursorContainerRef.current
            }

            initLocalState(provider, name, color, false, {})

            const onYjsTreeChanges = (events: Array<YEvent<any>>, transaction: Transaction) => {
                const origin = transaction.origin
                if (origin !== binding) {
                    const isFromUndoManager = origin instanceof UndoManager
                    syncYjsChangesToLexical(binding, provider, events, isFromUndoManager)
                }
            }

            binding.root.getSharedType().observeDeep(onYjsTreeChanges)

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

            const removeFocusCommand = editor.registerCommand(
                FOCUS_COMMAND,
                () => {
                    setLocalStateFocus(provider, name, color, true, {})
                    return false
                },
                COMMAND_PRIORITY_EDITOR,
            )

            const removeBlurCommand = editor.registerCommand(
                BLUR_COMMAND,
                () => {
                    setLocalStateFocus(provider, name, color, false, {})
                    return false
                },
                COMMAND_PRIORITY_EDITOR,
            )

            const onAwarenessUpdate = () => {
                syncCursorPositions(binding, provider, { selectionHighlight: true })
            }
            awareness.on('update', onAwarenessUpdate)
            syncCursorPositions(binding, provider, { selectionHighlight: true })

            cleanup = () => {
                awareness.off('update', onAwarenessUpdate)
                removeFocusCommand()
                removeBlurCommand()
                binding.root.getSharedType().unobserveDeep(onYjsTreeChanges)
                removeUpdateListener()
            }
        })()

        return () => {
            cancelled = true
            cleanup?.()
        }
    }, [editor, doc, sync, awareness, name, color])

    return (
        <CursorContainer
            onReady={(element) => {
                cursorContainerRef.current = element
            }}
        />
    )
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
    awareness,
    awarenessName,
    awarenessColor,
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
                <CollaborationBinding
                    doc={doc}
                    sync={sync}
                    awareness={awareness}
                    name={awarenessName}
                    color={awarenessColor}
                />
                <ClearEffect onClearReady={onClearReady} />
            </div>
        </LexicalComposer>
    )
}
