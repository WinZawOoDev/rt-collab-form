import { useForm } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

import type { Message } from './types'

type EvaluatePanelProps = {
    messages: Message[]
    disableSend?: boolean
    onSendMessage: (content: string) => Promise<boolean>
}

type EvaluateMessageFormValues = {
    content: string
}

export function EvaluatePanel({
    messages,
    disableSend = false,
    onSendMessage,
}: EvaluatePanelProps) {
    const form = useForm<EvaluateMessageFormValues>({
        mode: 'onSubmit',
        defaultValues: {
            content: '',
        },
    })

    const handleSubmit = async (values: EvaluateMessageFormValues) => {
        const isSent = await onSendMessage(values.content.trim())
        if (isSent) {
            form.reset()
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
                                    minLength: {
                                        value: 2,
                                        message: 'Evaluation message must be at least 2 characters.',
                                    },
                                }}
                                render={({ field }) => (
                                    <FormItem>
                                        <FormControl>
                                            <Input placeholder="Write an evaluation message..." {...field} />
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
