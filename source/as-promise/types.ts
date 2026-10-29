import {type RequestEvents} from '../core/index.js';
import type {Response} from '../core/response.js';
import type {StandardSchemaV1, StandardSchemaV1InferOutput} from '../core/standard-schema.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Internal recursive shape requires interface; public API remains a type alias.
interface RequestPromiseShape<T extends Response | Response['body'] = Response['body']> extends RequestEvents<RequestPromise<T>> {
	json: {
		/**
		A shortcut method that gives a Promise returning a JSON object.

		It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'json'`.
		*/
		<ReturnType>(schema?: undefined): RequestPromise<ReturnType>;

		/**
		A shortcut method that gives a Promise returning a JSON object validated with a [Standard Schema](https://standardschema.dev)-compatible validator, such as [Zod](https://github.com/colinhacks/zod) or [Valibot](https://valibot.dev). The promise resolves with the output of the schema, and the return type is inferred from it.

		A custom `parseJson` option runs first, so the schema receives the parsed body. The `validate` method of the schema may return a Promise.

		An empty response body parses to an empty string, the same as for `.json()`, so the schema receives `''`.

		Throws a `SchemaValidationError` when the body does not match the schema.

		Throws a `TypeError` when the argument does not follow the Standard Schema specification, for example when it has no `~standard.validate` method.

		@example
		```
		import got from 'got';
		import {z} from 'zod';

		const userSchema = z.object({name: z.string()});

		const user = await got('https://example.com/user').json(userSchema);
		```
		*/
		<Schema extends StandardSchemaV1>(schema: Schema): RequestPromise<StandardSchemaV1InferOutput<Schema>>;
	};

	/**
	A shortcut method that gives a Promise returning a [Uint8Array](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array).

	It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'buffer'`.
	*/
	buffer: () => RequestPromise<Uint8Array<ArrayBuffer>>;

	/**
	A shortcut method that gives a Promise returning a string.

	It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'text'`.
	*/
	text: () => RequestPromise<string>;
}

// This is intentionally a type alias to keep structural typing predictable.
// Augmenting it via interface merging is not supported.
export type RequestPromise<T extends Response | Response['body'] = Response['body']> = Promise<T> & RequestPromiseShape<T>;
