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

### <code>got(options: [OptionsInit](typescript.md#optionsinit))</code>

**Returns: <code>Promise<[Response](3-streams.md#response-1)></code>**

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

It is semantically the same as setting [`options.resolveBodyOnly`](2-options.md#resolvebodyonly) to `true` and [`options.responseType`](2-options.md#responsetype) to `'json'`.

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
