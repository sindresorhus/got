[> Back to homepage](../readme.md#documentation)

## Promise API

Source code: [`source/as-promise/index.ts`](../source/as-promise/index.ts)

The main Got function returns a [`Promise`](https://developer.mozilla.org/pl/docs/Web/JavaScript/Reference/Global_Objects/Promise).\
Although in order to support cancelation, [`PCancelable`](https://github.com/sindresorhus/p-cancelable) is used instead of pure `Promise`.

### <code>got(url: string | URL, options?: [OptionsInit](typescript.md#optionsinit), defaults?: [Options](2-options.md))</code>

**Returns: <code>Promise<[Response](response.md)>**</code>

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

### <code>got(options: [OptionsInit](typescript.md#optionsinit))</code>

**Returns: <code>Promise<[Response](3-streams.md#response-1)>**</code>

Alternatively, you can pass only options containing a `url` property.

```js
import got from 'got';

const {headers} = await got(
	{
		url: 'https://httpbin.org/anything',
		headers: {
			foo: 'bar'
		}
	}
).json();
```

This is semantically the same as the first approach.

### `promise.json<T>()`

**Returns: `Promise<T>`**

A shortcut method that gives a Promise returning a JSON object.

It is semantically the same as settings [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'json'`.

### `promise.buffer()`

**Returns: `Promise<Buffer>`**

A shortcut method that gives a Promise returning a [Buffer](https://nodejs.org/api/buffer.html).

It is semantically the same as settings [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'buffer'`.

### `promise.text()`

**Returns: `Promise<string>`**

A shortcut method that gives a Promise returning a string.

It is semantically the same as settings [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'text'`.

### `promise.cancel(reason?: string)`

Cancels the request and optionally provide a reason.

The cancellation is synchronous.\
Calling it after the promise has settled or multiple times does nothing.

This will cause the promise to reject with [`CancelError`](8-errors.md#cancelerror).

### `promise.isCanceled`

**Type: `boolean`**

Whether the promise is canceled.

### `promise.on(event, handler)`

The events are the same as in [Stream API](3-streams.md#events).
