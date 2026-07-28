// Type definitions for optional native audio-capture module
declare module 'audio-capture-napi' {
  export interface AudioCaptureOptions {
    sampleRate?: number;
    channels?: number;
    format?: 'Int16' | 'Float32';
  }

  export interface AudioCapture {
    start(options?: AudioCaptureOptions): void;
    stop(): void;
    on(event: 'data', callback: (buffer: ArrayBuffer) => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
  }

  export function createCapture(options?: AudioCaptureOptions): AudioCapture;
  export function isNativeAudioAvailable(): boolean;
  export function isNativeRecordingActive(): boolean;
  export function startNativeRecording(onData: (data: Buffer) => void, onSilence: () => void): boolean;
  export function stopNativeRecording(): void;
}
