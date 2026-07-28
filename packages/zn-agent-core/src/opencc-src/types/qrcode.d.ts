/**
 * Type declarations for the qrcode module (node-qrcode).
 * Based on the API observed in node_modules/qrcode/lib/server.js
 */

declare module 'qrcode' {
  export interface QRCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' | 'low' | 'medium' | 'quartile' | 'high'
    errorCorrectionLevel?: string
    type?: string
    small?: boolean
    version?: number
    maskPattern?: number
    toSJISFunc?: (char: string) => number
    optimize?: boolean
    optimizationLevel?: number
    scale?: number
    width?: number
    margin?: number
    margin?: number
    color?: {
      dark?: string
      light?: string
    }
  }

  export interface QRCodeToStringOptions extends QRCodeOptions {
    type?: 'utf8' | 'terminal' | 'svg'
  }

  export interface QRCode {
    modules: boolean[][]
    modulesize: number
    width: number
    data: Uint8Array
  }

  export type QRCodeCallback = (error: Error | null, result: string | undefined) => void

  export function create(text: string, options?: QRCodeOptions): QRCode

  export function toString(
    text: string,
    callback: QRCodeCallback,
  ): void
  export function toString(
    text: string,
    options: QRCodeToStringOptions,
    callback: QRCodeCallback,
  ): void
  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>

  export function toDataURL(
    text: string,
    callback: QRCodeCallback,
  ): void
  export function toDataURL(
    text: string,
    options: QRCodeOptions,
    callback: QRCodeCallback,
  ): void
  export function toDataURL(text: string, options?: QRCodeOptions): Promise<string>

  export function toBuffer(
    text: string,
    callback: QRCodeCallback,
  ): void
  export function toBuffer(
    text: string,
    options: QRCodeOptions,
    callback: QRCodeCallback,
  ): void
  export function toBuffer(text: string, options?: QRCodeOptions): Promise<Buffer>

  export function toFile(
    path: string,
    text: string,
    callback: QRCodeCallback,
  ): void
  export function toFile(
    path: string,
    text: string,
    options: QRCodeOptions,
    callback: QRCodeCallback,
  ): void
  export function toFile(path: string, text: string, options?: QRCodeOptions): Promise<void>

  export function toFileStream(
    stream: NodeJS.WritableStream,
    text: string,
    options?: QRCodeOptions,
  ): void

  export function toCanvas(
    canvas: HTMLElement,
    text: string,
    options?: QRCodeOptions,
  ): Promise<void>
}
