import { z } from 'zod';

// Bounded identifier patterns used on short config labels; reviewed for config-only input.
// eslint-disable-next-line security/detect-unsafe-regex
const snakeCase = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const envRef = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

const labelledNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    label: z.string().regex(snakeCase).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

const readSchema = z
  .object({
    defaultBrowseDepth: z.number().int().min(0).default(1),
    maxBrowseDepth: z.number().int().min(0).default(10),
    maxReadBatchSize: z.number().int().min(1).max(500).default(50),
    roots: z.array(labelledNodeSchema).default([]),
  })
  .strict()
  .superRefine((read, ctx) => {
    if (read.defaultBrowseDepth > read.maxBrowseDepth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'read.defaultBrowseDepth cannot exceed maxBrowseDepth.',
      });
    }
  });

const connectionSchema = z
  .object({
    endpointUrl: z.string().min(1),
    securityMode: z.enum(['None', 'Sign', 'SignAndEncrypt']),
    securityPolicy: z.string().min(1),
    auth: z.discriminatedUnion('type', [
      z.object({ type: z.literal('anonymous') }).strict(),
      z
        .object({
          type: z.literal('usernamePassword'),
          username: z.string().regex(envRef, 'username must be an environment variable reference'),
          password: z.string().regex(envRef, 'password must be an environment variable reference'),
        })
        .strict(),
    ]),
  })
  .strict();

const auditSchema = z
  .object({
    file: z.string().min(1),
    maxReasonLength: z.number().int().min(1).max(10_000).default(1000),
  })
  .strict();

export const appConfigSchema = z
  .object({
    version: z.literal(2),
    connection: connectionSchema,
    read: readSchema.default({}),
    audit: auditSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    const names = new Set<string>();
    for (const root of config.read.roots) {
      if (root.label !== undefined) {
        if (names.has(root.label)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate agent-facing name ${root.label}.`,
          });
        }
        names.add(root.label);
      }
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
