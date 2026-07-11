import { z } from 'zod/v4';
export declare function lazySchema<T>(factory: () => T): () => T;
