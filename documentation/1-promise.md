[> Back to homepage](../readme.md#documentation)

## Promise API

Source code: [`source/as-promise/index.ts`](../source/as-promise/index.ts)

The main Got function returns a [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise).\
Request aborting is supported via the [`signal` option](2-options.md#signal) and [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

### <code>got(url: string | URL, options?: [OptionsInit](typescript.md#optionsinit), defaults?: [Options](2-options.md))</code>

**Returns: <code>Promise<[Response](response.md)></code>**

The most common way is to pass the URL as the first argument, then the options as the second.

```js
import got from 'got';

const {headers} = await got(
	'https://httpbin.org/anything',
	{
		headers: {
			foo: 'bar'
		}
	}
).json();
```

### `promise.json<T>()`

**Returns: `Promise<T>`**

A shortcut method that gives a Promise returning a JSON object.

It is semantically the same as setting [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'json'`.

### `promise.json(schema)`

**Returns: `Promise<StandardSchemaV1InferOutput<Schema>>`**

A shortcut method that gives a Promise returning a JSON object validated with a [Standard Schema](https://standardschema.dev)-compatible validator, such as [Zod](https://github.com/colinhacks/zod) or [Valibot](https://valibot.dev). The promise resolves with the output of the schema, and the return type is inferred from it.

A custom [`parseJson`](2-options.md#parsejson) option runs first, so the schema receives the parsed body. The `validate` method of the schema may return a Promise.

An empty response body parses to an empty string, the same as for [`promise.json<T>()`](1-promise.md#promisejsont), so the schema receives `''`.

Throws a [`SchemaValidationError`](8-errors.md#schemavalidationerror) when the body does not match the schema.

> [!NOTE]
> A `TypeError` is thrown when the argument does not follow the Standard Schema specification, for example when it has no `~standard.validate` method.

```js
import got from 'got';
import {z} from 'zod';

const userSchema = z.object({name: z.string()});

const user = await got('https://example.com/user').json(userSchema);

console.log(user.name);
```

### `promise.buffer()`

**Returns: `Promise<Uint8Array>`**

A shortcut method that gives a Promise returning a [Uint8Array](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array).

It is semantically the same as setting [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'buffer'`.

### `promise.text()`

**Returns: `Promise<string>`**

A shortcut method that gives a Promise returning a string.

It is semantically the same as setting [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'text'`.

### `promise.on(event, handler)`

The events are the same as in [Stream API](3-streams.md#events).

The `response` event fires once, with the response the promise resolves with. It does not fire for a response that is retried, or for an `HTTPError` response when [`throwHttpErrors`](2-options.md#throwhttperrors) is `true`. A `response` listener that throws rejects the promise with that error.

### `promise.once(event, handler)`

Registers a one-time listener for events from [Stream API](3-streams.md#events).

### `promise.off(event, handler)`

Removes listener registered with [`promise.on`](1-promise.md#promiseonevent-handler).

```js
import {createReadStream} from 'node:fs';
import got from 'got';

const ongoingRequestPromise = got.post(uploadUrl, {
    body: createReadStream('sample.txt')
});

const eventListener = (progress: Progress) => {
    console.log(progress);
};

ongoingRequestPromise.on('uploadProgress', eventListener);

setTimeout(() => {
    ongoingRequestPromise.off('uploadProgress', eventListener);
}, 500);

await ongoingRequestPromise;
```
