// Bridge webhook sanitizer types
export type WebhookSanitizer = {
  sanitize: (input: string) => string
}
