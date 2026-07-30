// SSH session manager types
export type SSHSession = {
  id: string
  // Add other properties as needed
}

export type SSHSessionManager = {
  createSession: (options: unknown) => Promise<SSHSession>
  // Add other methods as needed
}
