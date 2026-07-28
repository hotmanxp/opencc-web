// Type declarations for .md file imports used by Bun's text loader
declare module '*.md' {
  const content: string
  export default content
}
