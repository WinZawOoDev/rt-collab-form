import type { FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import type { Message } from './types'

type EvaluatePanelProps = {
    messages: Message[]
    messageText: string
    canSend: boolean
    onMessageTextChange: (value: string) => void
    onSendMessage: (event: FormEvent<HTMLFormElement>) => void
}

export function EvaluatePanel({
    messages,
    messageText,
    canSend,
    onMessageTextChange,
    onSendMessage,
}: EvaluatePanelProps) {
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

                <form className="flex gap-2" onSubmit={onSendMessage}>
                    <Input
                        placeholder="Write a message..."
                        value={messageText}
                        onChange={(event) => onMessageTextChange(event.target.value)}
                    />
                    <Button type="submit" disabled={!canSend}>
                        Send
                    </Button>
                </form>
            </CardContent>
        </Card>
    )
}
