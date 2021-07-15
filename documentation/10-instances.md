[> Back to homepage](../readme.md#documentation)

## Instances

Source code: [`source/create.ts`](../source/create.ts)

### `got.defaults`

#### `options`

**Type: [`Options`](2-options.md)**

The options used for this instance.

#### `handlers`

**Type: [`Handler[]`](typescript.md#handler)**

```ts
(options: Options, next: …) => next(options)
```

An array of handlers. The `next` function returns a [`Promise`](1-promise.md) or a [`Request` Got stream](3-streams.md).

You execute them directly by calling `got(…)`. They are some sort of "global hooks" - these functions are called first. The last handler (it's invisible) is either `asPromise` or `asStream`, depending on the `options.isStream` property.

#### `mutableDefaults`

**Type: `boolean`**\
**Default: `false`**

Determines whether `got.defaults.options` can be modified.

### `got.extend(…options, …instances)`

**Tip:**
> - `options` can include `handlers` and `mutableDefaults`.

**Note:**
> - Properties that are not enumerable, such as `body`, `json`, and `form`, will not be merged.

Configure a new `got` instance with merged default options. The options are merged with the parent instance's `defaults.options` using [`options.merge(…)`](2-options.md#merge).

```js
import got from 'got';

const client = got.extend({
	prefixUrl: 'https://httpbin.org',
	headers: {
		'x-foo': 'bar'
	}
});

const {headers} = await client.get('headers').json();
console.log(headers['x-foo']); //=> 'bar'

const jsonClient = client.extend({
	responseType: 'json',
	resolveBodyOnly: true,
	headers: {
		'x-lorem': 'impsum'
	}
});

const {headers: headers2} = await jsonClient.get('headers');
console.log(headers2['x-foo']);   //=> 'bar'
console.log(headers2['x-lorem']); //=> 'impsum'
```

**Note:**
> - Handlers can be asynchronous and can return a `Promise`, but never a `Promise<Stream>` if `options.isStream` is `true`.
> - Streams must always be handled synchronously.
> - In order to perform async work using streams, the `beforeRequest` hook should be used instead.

The recommended approach for creating handlers that can handle both promises and streams is:

```js
import got from 'got';

// Create a non-async handler, but we can return a Promise later.
const handler = (options, next) => {
	if (options.isStream) {
		// It's a Stream, return synchronously.
		return next(options);
	}

	// For asynchronous work, return a Promise.
	return (async () => {
		try {
			const response = await next(options);
			response.yourOwnProperty = true;
			return response;
		} catch (error) {
			// Every error will be replaced by this one.
			// Before you receive any error here,
			// it will be passed to the `beforeError` hooks first.
			// Note: this one won't be passed to `beforeError` hook. It's final.
			throw new Error('Your very own error.');
		}
	})();
};

const instance = got.extend({handlers: [handler]});
```
