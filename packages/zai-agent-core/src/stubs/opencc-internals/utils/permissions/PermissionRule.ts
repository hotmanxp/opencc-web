import { z } from 'zod/v4';

// Zod schema with optional() method chain
const baseSchema = z.string();
export const permissionBehaviorSchema = () => baseSchema.optional();
