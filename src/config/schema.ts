import { z } from 'zod';

// Bounded identifier patterns used on short config labels; reviewed for config-only input.
// eslint-disable-next-line security/detect-unsafe-regex
const snakeCase = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
// eslint-disable-next-line security/detect-unsafe-regex
const groupPath = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const envRef = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

export const writableDataTypes = [
  'Boolean',
  'SByte',
  'Byte',
  'Int16',
  'UInt16',
  'Int32',
  'UInt32',
  'Float',
  'Double',
  'String',
] as const;

const integerRanges: Partial<
  Record<(typeof writableDataTypes)[number], { min: number; max: number }>
> = {
  SByte: { min: -128, max: 127 },
  Byte: { min: 0, max: 255 },
  Int16: { min: -32768, max: 32767 },
  UInt16: { min: 0, max: 65535 },
  Int32: { min: -2147483648, max: 2147483647 },
  UInt32: { min: 0, max: 4294967295 },
};

const finiteNumber = z.number().finite();

const labelledNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    label: z.string().regex(snakeCase).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

const allowedValueSchema = z
  .object({
    label: z.string().regex(snakeCase),
    value: z.union([z.string(), finiteNumber]),
  })
  .strict();

const readNodeSchema = labelledNodeSchema
  .extend({
    dataType: z.enum(writableDataTypes).optional(),
    unit: z.string().min(1).optional(),
    allowedValues: z.array(allowedValueSchema).min(1).optional(),
    falseLabel: z.string().regex(snakeCase).optional(),
    trueLabel: z.string().regex(snakeCase).optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    const hasBooleanLabels = node.falseLabel !== undefined || node.trueLabel !== undefined;
    if (hasBooleanLabels && (node.falseLabel === undefined || node.trueLabel === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Boolean mappings require both falseLabel and trueLabel.',
      });
    }
    if (node.allowedValues !== undefined && node.dataType === 'Boolean') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Boolean mappings use falseLabel/trueLabel, not allowedValues.',
      });
    }
  });

const readScopeSchema = z
  .object({
    defaultDepth: z.number().int().min(0).default(3),
    maxDepth: z.number().int().min(0).default(10),
    maxReadBatchSize: z.number().int().min(1).max(500).default(50),
    roots: z
      .array(labelledNodeSchema.extend({ depth: z.number().int().min(0).optional() }).strict())
      .default([]),
    nodes: z.array(readNodeSchema).default([]),
    exclude: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            kind: z.enum(['exact', 'subtree']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (scope.defaultDepth > scope.maxDepth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'readScope.defaultDepth cannot exceed maxDepth.',
      });
    }
    const explicitNodeIds = new Set(scope.nodes.map((node) => node.nodeId));
    for (const excluded of scope.exclude) {
      if (explicitNodeIds.has(excluded.nodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `NodeId ${excluded.nodeId} is both explicitly readable and excluded.`,
        });
      }
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

const controlBaseSchema = z
  .object({
    name: z.string().regex(snakeCase),
    group: z.string().regex(groupPath).optional(),
    description: z.string().min(1),
    nodeId: z.string().min(1),
    riskLevel: z.enum(['low', 'medium']),
    riskNote: z.string().min(1),
    cooldownMs: z.number().int().min(0).optional(),
    requireCurrentValueForConfirmation: z.boolean().optional(),
  })
  .strict();

const booleanControlSchema = controlBaseSchema
  .extend({
    dataType: z.literal('Boolean'),
    falseLabel: z.string().regex(snakeCase),
    trueLabel: z.string().regex(snakeCase),
  })
  .strict();

const enumControlSchema = controlBaseSchema
  .extend({
    dataType: z.enum(writableDataTypes).exclude(['Boolean']),
    allowedValues: z.array(allowedValueSchema).min(1),
  })
  .strict();

const numericControlSchema = controlBaseSchema
  .extend({
    dataType: z.enum(['SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double']),
    unit: z.string().min(1),
    min: finiteNumber,
    max: finiteNumber,
  })
  .strict();

const controlItemSchema = z
  .union([booleanControlSchema, enumControlSchema, numericControlSchema])
  .superRefine((control, ctx) => {
    if (
      control.requireCurrentValueForConfirmation !== undefined &&
      control.riskLevel !== 'medium'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'requireCurrentValueForConfirmation is only valid for medium-risk controls.',
      });
    }
    if ('min' in control && control.min > control.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Control min cannot exceed max.' });
    }
    if ('min' in control) {
      const range = integerRanges[control.dataType];
      if (range !== undefined && (control.min < range.min || control.max > range.max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Bounds exceed ${control.dataType} range.`,
        });
      }
    }
    if ('allowedValues' in control) {
      const labels = new Set<string>();
      for (const allowed of control.allowedValues) {
        if (labels.has(allowed.label)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate allowed value label ${allowed.label}.`,
          });
        }
        labels.add(allowed.label);
      }
    }
  });

const controlsSchema = z
  .object({
    enabled: z.boolean(),
    defaults: z
      .object({
        cooldownMs: z.number().int().min(0).default(1000),
        mediumConfirmationTtlMs: z.number().int().min(1).default(60_000),
      })
      .strict()
      .default({}),
    items: z.array(controlItemSchema).default([]),
  })
  .strict();

export const appConfigSchema = z
  .object({
    version: z.literal(1),
    server: z.object({ mode: z.enum(['readOnly', 'readWrite']) }).strict(),
    connection: connectionSchema,
    readScope: readScopeSchema,
    audit: auditSchema,
    controls: controlsSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.server.mode === 'readOnly' && config.controls !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'readOnly mode rejects controls config.',
      });
    }
    if (config.server.mode === 'readWrite' && config.controls === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'readWrite mode requires controls config.',
      });
    }

    const names = new Set<string>();
    for (const root of config.readScope.roots) {
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
    for (const node of config.readScope.nodes) {
      if (node.label !== undefined) {
        if (names.has(node.label)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate agent-facing name ${node.label}.`,
          });
        }
        names.add(node.label);
      }
    }
    for (const control of config.controls?.items ?? []) {
      if (names.has(control.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate agent-facing name ${control.name}.`,
        });
      }
      names.add(control.name);
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ControlItem = NonNullable<AppConfig['controls']>['items'][number];
