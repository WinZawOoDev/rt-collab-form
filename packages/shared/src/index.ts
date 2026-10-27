export type ApiUser = {
  id: number
  email: string
  name: string | null
}

export type ApiMessage = {
  id: number
  author: string
  content: string
  timestamp: number
  authorId: number | null
}

export type TeamDraftState = {
  state: string
  revision: number
}

export type SseTypingPayload = {
  userId: number
  name: string
  isTyping: boolean
}

export type SseDraftUpdatePayload = {
  update: string
  revision: number
  authorId: number
}

export type SseMessageDeletePayload = {
  id: number
}
