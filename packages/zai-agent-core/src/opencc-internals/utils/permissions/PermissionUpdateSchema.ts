// @ts-nocheck
import { z } from 'zod/v4';

const baseSchema = z.unknown();
export const permissionUpdateSchema = () => baseSchema.optional();