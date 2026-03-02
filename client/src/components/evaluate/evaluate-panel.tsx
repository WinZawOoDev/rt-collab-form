import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { EvaluateLexicalInput } from '@/components/evaluate/evaluate-lexical-input'

import type { Message } from './types'

type EvaluatePanelProps = {
    messages: Message[]
    disableSend?: boolean
    initialDraftContent?: string
    initialDraftLexicalJson?: string
    onDraftChange?: (content: string, lexicalJson: string) => Promise<void>
    onSendMessage: (content: string) => Promise<boolean>
}

type EvaluateMessageFormValues = {
    content: string
}

export function EvaluatePanel({
    messages,
    disableSend = false,
    initialDraftContent = '',
    initialDraftLexicalJson = '',
    onDraftChange,
    onSendMessage,
}: EvaluatePanelProps) {
    const [editorResetKey, setEditorResetKey] = useState(0)
    const [lexicalJson, setLexicalJson] = useState(initialDraftLexicalJson)

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
        () => !disableSend && typeof onDraftChange === 'function',
        [disableSend, onDraftChange],
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
                                <p className="mt-1 text-sm">{message.content}</p>
                                <p className="mt-2 text-right text-[11px] opacity-70">{message.timestamp}</p>
                            </div>
                        </div>
                    ))}
                </section>

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

                        <Button type="submit" disabled={disableSend || form.formState.isSubmitting}>
                            Send
                        </Button>
                    </form>
                </Form>
            </CardContent>
        </Card>
    )
}
