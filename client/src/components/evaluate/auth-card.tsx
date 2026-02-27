import { useForm } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card'
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

export type AuthFormValues = {
    email: string
    password: string
}

type AuthCardProps = {
    isAuthenticated: boolean
    email: string
    password: string
    currentName: string
    onSubmit: (values: AuthFormValues) => Promise<void>
    onLogout: () => void
}

export function AuthCard({
    isAuthenticated,
    email,
    password,
    currentName,
    onSubmit,
    onLogout,
}: AuthCardProps) {
    const form = useForm<AuthFormValues>({
        mode: 'onSubmit',
        defaultValues: {
            email,
            password,
        },
    })

    return (
        <Card>
            <CardHeader>
                <CardTitle>Authentication</CardTitle>
                <CardDescription>Sign in to start evaluationg with your team.</CardDescription>
            </CardHeader>
            <CardContent>
                <Form {...form}>
                    <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
                        <FormField
                            control={form.control}
                            name="email"
                            rules={{
                                required: 'Email is required.',
                                pattern: {
                                    value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                                    message: 'Enter a valid email address.',
                                },
                            }}
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Email</FormLabel>
                                    <FormControl>
                                        <Input type="email" placeholder="you@example.com" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="password"
                            rules={{
                                required: 'Password is required.',
                                minLength: {
                                    value: 6,
                                    message: 'Password must be at least 6 characters.',
                                },
                            }}
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Password</FormLabel>
                                    <FormControl>
                                        <Input type="password" placeholder="••••••••" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button className="w-full" type="submit" disabled={isAuthenticated || form.formState.isSubmitting}>
                            {isAuthenticated ? 'Authenticated' : 'Sign In'}
                        </Button>
                        {isAuthenticated ? (
                            <Button className="w-full" type="button" variant="secondary" onClick={onLogout}>
                                Logout
                            </Button>
                        ) : null}
                    </form>
                </Form>
            </CardContent>
            <CardFooter>
                <p className="text-muted-foreground text-xs">
                    {isAuthenticated
                        ? `Signed in as ${currentName}.`
                        : 'Use any credentials to preview the evaluation UI.'}
                </p>
            </CardFooter>
        </Card>
    )
}
