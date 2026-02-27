export type Message = {
  id: number
  author: string
  content: string
  timestamp: string
  authorId?: number | null
  mine?: boolean
}
