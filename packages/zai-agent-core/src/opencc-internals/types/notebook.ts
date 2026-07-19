// @ts-nocheck
export interface NotebookCell {
  id: string;
  source: NotebookCellSource;
  outputs?: NotebookCellOutput[];
}

export interface NotebookCellOutput {
  items?: NotebookCellSourceOutput[];
}

export interface NotebookCellSource {
  type: 'code' | 'text';
  content: string;
}

export interface NotebookCellSourceOutput {
  type: 'image' | 'text' | 'error';
  content?: string;
  mimeType?: string;
}

export interface NotebookContent {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
}

export interface NotebookOutputImage {
  data: string;
  mimeType: string;
}