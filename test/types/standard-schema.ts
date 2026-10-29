import {expectTypeOf} from 'expect-type';
import got, {
	type RequestPromise,
	type StandardSchemaV1,
	type StandardSchemaV1InferOutput,
} from '../../source/index.js';
import type {StandardSchemaV1Result, StandardSchemaV1Types} from '../../source/core/standard-schema.js';

const schema: StandardSchemaV1<unknown, {name: string}> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: () => ({value: {name: 'Sindre'}}),
	},
};

expectTypeOf(got('https://example.com').json()).toEqualTypeOf<RequestPromise>();
expectTypeOf(got('https://example.com').json<{name: string}>()).toEqualTypeOf<RequestPromise<{name: string}>>();
expectTypeOf(got('https://example.com').json(undefined)).toEqualTypeOf<RequestPromise>();
expectTypeOf(got('https://example.com').json<{name: string}>(undefined)).toEqualTypeOf<RequestPromise<{name: string}>>();
expectTypeOf(got('https://example.com').json(schema)).toEqualTypeOf<RequestPromise<{name: string}>>();

// A schema without a `types` property infers the output from the successful result of `validate`.
const inferredSchema = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: async () => ({value: 1}),
	},
} satisfies StandardSchemaV1;

expectTypeOf(got('https://example.com').json(inferredSchema)).toEqualTypeOf<RequestPromise<number>>();

// A schema with a loosely typed `validate` but a precise `types` property infers the output from `types`.
type PreciseTypesSchema = {
	'~standard': {
		readonly version: 1;
		readonly vendor: 'test';
		readonly validate: (value: unknown) => StandardSchemaV1Result<unknown>;
		readonly types: StandardSchemaV1Types<unknown, {name: string}>;
	};
};

expectTypeOf(got('https://example.com').json({} as PreciseTypesSchema)).toEqualTypeOf<RequestPromise<{name: string}>>();

// A transforming schema, such as `z.string().transform(Number)`, resolves with its output type, not its input type.
declare const transformingSchema: StandardSchemaV1<string, number>;
expectTypeOf(got('https://example.com').json(transformingSchema)).toEqualTypeOf<RequestPromise<number>>();

// A schema annotated with the bare `StandardSchemaV1` must infer `unknown`, not `any`.
const looselyTypedSchema: StandardSchemaV1 = schema;
expectTypeOf(got('https://example.com').json(looselyTypedSchema)).toEqualTypeOf<RequestPromise>();

// The validated type survives chaining through the event methods.
expectTypeOf(got('https://example.com').json(schema).on('response', () => {})).toEqualTypeOf<RequestPromise<{name: string}>>();

// Users who wrap a schema can reuse the helper that the overload uses.
expectTypeOf<StandardSchemaV1InferOutput<typeof schema>>().toEqualTypeOf<{name: string}>();

// @ts-expect-error Non-schema objects must not match either overload.
expectTypeOf(got('https://example.com').json({}));

// @ts-expect-error `null` is not a schema.
expectTypeOf(got('https://example.com').json(null));

// @ts-expect-error A schema supplies the return type.
expectTypeOf(got('https://example.com').json<{name: string}>(schema));
