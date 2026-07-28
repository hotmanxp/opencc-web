// Type definitions for image-processor-napi module
declare module 'image-processor-napi' {
  export interface ImageProcessorOptions {
    width?: number;
    height?: number;
    quality?: number;
    format?: 'png' | 'jpeg' | 'webp';
  }

  export interface ProcessedImage {
    data: Buffer;
    width: number;
    height: number;
    format: string;
  }

  export function processImage(buffer: Buffer, options?: ImageProcessorOptions): Promise<ProcessedImage>;
}
