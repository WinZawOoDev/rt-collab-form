import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Pencil, Trash2, Check, X } from 'lucide-react'
import { useForm } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { EvaluateLexicalInput } from '@/components/evaluate/evaluate-lexical-input'

import type { Message } from './types'

type EvaluatePanelProps = {
    messages: Message[]
    typingUsers?: string[]
    initialDraftContent?: string
    initialDraftLexicalJson?: string
    onDraftChange?: (content: string, lexicalJson: string) => Promise<void>
    onSendMessage: (content: string) => Promise<boolean>
    onEditMessage?: (id: number, content: string) => Promise<boolean>
    onDeleteMessage?: (id: number) => Promise<boolean>
}

type EvaluateMessageFormValues = {
    content: string
}

export function EvaluatePanel({
    messages,
    typingUsers = [],
    initialDraftContent = '',
    initialDraftLexicalJson = '',
    onDraftChange,
    onSendMessage,
    onEditMessage,
    onDeleteMessage,
}: EvaluatePanelProps) {
    const [editorResetKey, setEditorResetKey] = useState(0)
    const [lexicalJson, setLexicalJson] = useState(initialDraftLexicalJson)
    const [editingId, setEditingId] = useState<number | null>(null)
    const [editValue, setEditValue] = useState('')
    const [isSavingEdit, setIsSavingEdit] = useState(false)
    const [deletingId, setDeletingId] = useState<number | null>(null)

    const form = useForm<EvaluateMessageFormValues>({
        mode: 'onSubmit',
        defaultValues: {
            content: initialDraftContent,
        },
    })

    const content = form.watch('content')

    useEffect(() => {
        form.reset({ content: initialDraftContent })
        setLexicalJson(initialDraftLexicalJson)
        setEditorResetKey((previous) => previous + 1)
    }, [form, initialDraftContent, initialDraftLexicalJson])

    const shouldPersistDraft = useMemo(
        () => typeof onDraftChange === 'function',
        [onDraftChange],
    )

    useEffect(() => {
        if (!shouldPersistDraft || !onDraftChange) {
            return
        }

        const timeoutId = window.setTimeout(() => {
            void onDraftChange(content ?? '', lexicalJson)
        }, 600)

        return () => {
            window.clearTimeout(timeoutId)
        }
    }, [content, lexicalJson, onDraftChange, shouldPersistDraft])

    const handleSubmit = async (values: EvaluateMessageFormValues) => {
        const isSent = await onSendMessage(values.content.trim())
        if (isSent) {
            form.reset()
            setLexicalJson('')
            if (onDraftChange) {
                await onDraftChange('', '')
            }
            setEditorResetKey((previous) => previous + 1)
        }
    }

    const startEditing = (message: Message) => {
        setEditingId(message.id)
        setEditValue(message.content)
    }

    const cancelEditing = () => {
        setEditingId(null)
        setEditValue('')
    }

    const handleEditSubmit = async (event: FormEvent) => {
        event.preventDefault()

        if (editingId === null || !onEditMessage || isSavingEdit) {
            return
        }

        const trimmed = editValue.trim()
        if (!trimmed) {
            return
        }

        setIsSavingEdit(true)
        const updated = await onEditMessage(editingId, trimmed)
        setIsSavingEdit(false)

        if (updated) {
            cancelEditing()
        }
    }

    const handleDelete = async (id: number) => {
        if (!onDeleteMessage || deletingId !== null) {
            return
        }

        setDeletingId(id)
        await onDeleteMessage(id)
        setDeletingId(null)
    }

    return (
        <Card className="h-[70vh]">
            <CardHeader>
                <CardTitle>Team Evaluation</CardTitle>
                <CardDescription>Message list and real-time evaluation form layout.</CardDescription>
            </CardHeader>

            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                <section className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
                    {messages.map((message) => (
                        <div key={message.id} className={message.mine ? 'flex justify-end' : 'flex justify-start'}>
                            <div
                                className={
                                    message.mine
                                        ? 'max-w-[80%] rounded-lg bg-primary px-4 py-3 text-primary-foreground'
                                        : 'max-w-[80%] rounded-lg bg-muted px-4 py-3 text-foreground'
                                }
                            >
                                <p className="text-xs font-medium">{message.author}</p>

                                {editingId === message.id ? (
                                    <form className="mt-1 flex items-center gap-1" onSubmit={handleEditSubmit}>
                                        <Input
                                            value={editValue}
                                            onChange={(event) => setEditValue(event.target.value)}
                                            className="h-8 text-sm"
                                            autoFocus
                                        />
                                        <Button type="submit" size="icon-xs" variant="ghost" disabled={isSavingEdit}>
                                            <Check />
                                        </Button>
                                        <Button type="button" size="icon-xs" variant="ghost" onClick={cancelEditing}>
                                            <X />
                                        </Button>
                                    </form>
                                ) : (
                                    <p className="mt-1 text-sm">{message.content}</p>
                                )}

                                <p className="mt-2 text-right text-[11px] opacity-70">{message.timestamp}</p>

                                {message.mine && editingId !== message.id ? (
                                    <div className="mt-1 flex justify-end gap-1">
                                        <Button
                                            type="button"
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label="Edit message"
                                            onClick={() => startEditing(message)}
                                        >
                                            <Pencil />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label="Delete message"
                                            disabled={deletingId === message.id}
                                            onClick={() => void handleDelete(message.id)}
                                        >
                                            <Trash2 />
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ))}
                </section>

                {typingUsers.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing…
                    </p>
                ) : null}

                <Form {...form}>
                    <form className="flex items-start gap-2" onSubmit={form.handleSubmit(handleSubmit)}>
                        <div className="flex-1">
                            <FormField
                                control={form.control}
                                name="content"
                                rules={{
                                    required: 'Evaluation message is required.',
                                    validate: {
                                        minLength: (value) =>
                                            value.trim().length >= 2 ||
                                            'Evaluation message must be at least 2 characters.',
                                    },
                                }}
                                render={({ field }) => (
                                    <FormItem>
                                        <FormControl>
                                            <EvaluateLexicalInput
                                                initialContent={field.value}
                                                initialLexicalJson={lexicalJson}
                                                resetKey={editorResetKey}
                                                onChange={(nextContent, nextLexicalJson) => {
                                                    field.onChange(nextContent)
                                                    setLexicalJson(nextLexicalJson)
                                                }}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>

                        <Button type="submit" disabled={form.formState.isSubmitting}>
                            Send
                        </Button>
                    </form>
                </Form>
            </CardContent>
        </Card>
    )
}
