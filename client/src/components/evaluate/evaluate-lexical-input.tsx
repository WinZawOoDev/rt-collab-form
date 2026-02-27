import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { $getRoot, type EditorState } from 'lexical'

type EvaluateLexicalInputProps = {
    value: string
    resetKey: number
    onChange: (value: string) => void
}

export function EvaluateLexicalInput({ value, resetKey, onChange }: EvaluateLexicalInputProps) {
    return (
        <LexicalComposer
            key={resetKey}
            initialConfig={{
                namespace: 'evaluate-editor',
                editable: true,
                onError: (error) => {
                    throw error
                },
                editorState: () => {
                    $getRoot().clear().append()
                    if (value) {
                        $getRoot().selectEnd().insertText(value)
                    }
                },
            }}
        >
            <div className="relative min-h-9 rounded-md border border-input bg-transparent px-3 py-2 text-sm">
                <PlainTextPlugin
                    contentEditable={
                        <ContentEditable
                            className="min-h-5 outline-none"
                            aria-placeholder="Write an evaluation message..."
                            placeholder={<></>}
                        />
                    }
                    placeholder={
                        <span className="pointer-events-none absolute top-2 left-3 text-muted-foreground text-sm">
                            Write an evaluation message...
                        </span>
                    }
                    ErrorBoundary={({ children }) => <>{children}</>}
                />
                <HistoryPlugin />
                <OnChangePlugin
                    onChange={(editorState: EditorState) => {
                        editorState.read(() => {
                            onChange($getRoot().getTextContent())
                        })
                    }}
                />
            </div>
        </LexicalComposer>
    )
}
