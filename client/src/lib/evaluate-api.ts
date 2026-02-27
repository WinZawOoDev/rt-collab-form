type ApiUser = {
  id: number
  email: string
  name: string | null
}

type LoginResponse = {
  user: ApiUser
  token: string
}

export class ApiUnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'ApiUnauthorizedError'
  }
}

export type ApiMessage = {
  id: number
  author: string
  content: string
  timestamp: number
  authorId: number | null
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'
const AUTH_TOKEN_STORAGE_KEY = 'evaluate-auth-token'
let authToken = ''

function parseJwtPayload(token: string): { exp?: number } | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) {
      return null
    }

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = atob(padded)
    return JSON.parse(decoded) as { exp?: number }
  } catch {
    return null
  }
}

function isTokenExpired(token: string, leewaySeconds = 30) {
  const payload = parseJwtPayload(token)
  if (!payload?.exp) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  return payload.exp <= now + leewaySeconds
}

function ensureAuthTokenValid() {
  if (!authToken) {
    throw new ApiUnauthorizedError('No active session.')
  }

  if (isTokenExpired(authToken)) {
    clearAuthToken()
    throw new ApiUnauthorizedError('Session expired.')
  }
}

function getAuthHeaders() {
  ensureAuthTokenValid()

  return {
    Authorization: `Bearer ${authToken}`,
  }
}

export function setAuthToken(token: string) {
  authToken = token

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
  }
}

export function clearAuthToken() {
  authToken = ''

  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  }
}

export function hydrateAuthToken() {
  if (typeof window === 'undefined') {
    return ''
  }

  const storedToken = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || ''
  if (!storedToken) {
    authToken = ''
    return ''
  }

  if (isTokenExpired(storedToken)) {
    clearAuthToken()
    return ''
  }

  authToken = storedToken
  return storedToken
}

export async function login(email: string, name: string) {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, name }),
  })

  if (!response.ok) {
    throw new Error('Unable to authenticate.')
  }

  const data = (await response.json()) as LoginResponse
  setAuthToken(data.token)
  return data.user
}

export async function getMessages() {
  const response = await fetch(`${API_BASE_URL}/api/messages`, {
    headers: {
      ...getAuthHeaders(),
    },
  })

  if (response.status === 401) {
    throw new ApiUnauthorizedError('Session expired.')
  }

  if (!response.ok) {
    throw new Error('Unable to fetch messages.')
  }

  const data = (await response.json()) as { messages: ApiMessage[] }
  return data.messages
}

export async function getCurrentUser() {
  const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
    headers: {
      ...getAuthHeaders(),
    },
  })

  if (response.status === 401) {
    throw new ApiUnauthorizedError('Session expired.')
  }

  if (!response.ok) {
    throw new Error('Unable to fetch current user.')
  }

  const data = (await response.json()) as { user: ApiUser }
  return data.user
}

export async function sendMessage(content: string) {
  const response = await fetch(`${API_BASE_URL}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ content }),
  })

  if (response.status === 401) {
    throw new ApiUnauthorizedError('Session expired.')
  }

  if (!response.ok) {
    throw new Error('Unable to send message.')
  }

  const data = (await response.json()) as { message: ApiMessage }
  return data.message
}

export function getMessagesStreamUrl() {
  ensureAuthTokenValid()

  const params = new URLSearchParams({ token: authToken })
  return `${API_BASE_URL}/events/messages?${params.toString()}`
}
