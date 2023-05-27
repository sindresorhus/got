[> Back to homepage](../readme.md#documentation)

## Stream API

Source code: [`source/core/index.ts`](../source/core/index.ts)

### `got.stream(url, options, defaults)`
### `got(url, {...options, isStream: true}, defaults)`

The two functions above are exposed by the `got` main interface and return a new instance of `Request`.

### `new Request(url, options, defaults)`

**Extends: [`Duplex` stream](https://nodejs.org/api/stream.html#stream_class_stream_duplex)**

This constructor takes the same arguments as the Got promise.

**Note:**
> When piping to [`ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse), the headers will be automatically copied.\
> In order to prevent this behavior you need to override the request headers in a [`beforeRequest`](9-hooks.md#beforerequest) hook.

**Note:**
> If the `body`, `json` or `form` option is used, this stream will be read-only.

**Note:**
> - While `got.post('https://example.com')` resolves, `got.stream.post('https://example.com')` will hang indefinitely until a body is provided.
> - If there's no body on purpose, remember to `stream.end()` or set the body option to an empty string.

```js
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';
import got from 'got';

// This example streams the GET response of a URL to a file.
await streamPipeline(
	got.stream('https://sindresorhus.com'),
	fs.createWriteStream('index.html')
);

// For POST, PUT, PATCH, and DELETE methods, `got.stream` returns a `stream.Writable`.
// This example POSTs the contents of a file to a URL.
await streamPipeline(
	fs.createReadStream('index.html'),
	got.stream.post('https://sindresorhus.com'),
	new stream.PassThrough()
);

// In order to POST, PUT, PATCH, or DELETE without a request body, explicitly specify an empty body:
await streamPipeline(
	got.stream.post('https://sindresorhus.com', { body: '' }),
	new stream.PassThrough()
)
```

Please note that `new stream.PassThrough()` is required in order to catch read errors.\
If it was missing then `pipeline` wouldn't catch any read errors because there would be no stream to pipe to.\
In other words, it would only check errors when writing.

**Tip:**
> - Avoid `from.pipe(to)` as it doesn't forward errors.

### `stream.options`

**Type: [`Options`](2-options.md)**

The options used to make the request.

### `stream.response`

**Type: [`IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage)**

The underlying `IncomingMessage` instance.

### `stream.requestUrl`

**Type: [`URL`](https://nodejs.org/api/url.html#url_the_whatwg_url_api)**

The current `URL` object in this try.

### `stream.redirectUrls`

**Type: [`URL[]`](https://nodejs.org/api/url.html#url_the_whatwg_url_api)**

An array of URLs of consecutive requests.

### `stream.retryCount`

**Type: `number`**

The current retry count.

**Note:**
> - Must be overriden when retrying.

### `stream.ip`

**Type: `string | undefined`**

The destination IP address.

### `stream.isAborted`

**Type: `boolean`**

Whether the request has been aborted or not.

### `stream.socket`

**Type: `net.Socket | tls.Socket | undefined`**

The socket used for this particular request.

### `stream.downloadProgress`

**Type: [`Progress`](typescript.md#progress)**

An object representing how much data have been downloaded.

### `stream.uploadProgress`

**Type: [`Progress`](typescript.md#progress)**

An object representing how much data have been uploaded.

**Note:**
> - When a chunk is greater than `highWaterMark`, the progress won't be emitted. The body needs to be split into chunks.

```js
import got from 'got';

const body = Buffer.alloc(1024 * 1024); // 1MB

function* chunkify(buffer, chunkSize = 64 * 1024) {
	for (let pos = 0; pos < buffer.byteLength; pos += chunkSize) {
		yield buffer.subarray(pos, pos + chunkSize)
	}
}

const stream = got.stream.post('https://httpbin.org/anything', {
	body: chunkify(body)
});

stream.resume();

stream.on('uploadProgress', progress => {
	console.log(progress);
});
```

### `stream.timings`

**Type: [`Timings`](typescript.md#timings)**

An object representing performance information.

To generate the timings, Got uses the [`http-timer`](https://github.com/szmarczak/http-timer) package.

### `stream.isFromCache`

**Type: `boolean | undefined`**

Whether the response has been fetched from cache.

### `stream.reusedSocket`

**Type: `boolean`**

Whether the socket was used for other previous requests.

## Events

### `stream.on('response', …)`

#### `response`

**Type: [`PlainResponse`](typescript.md#plainresponse)**

This is emitted when a HTTP response is received.

```js
import {pipeline as streamPipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import got from 'got';

const readStream = got.stream('http://example.com/image.png', {throwHttpErrors: false});

const onError = error => {
	// Do something with it.
};

readStream.on('response', async response => {
	if (response.headers.age > 3600) {
		console.log('Failure - response too old');
		readStream.destroy(); // Destroy the stream to prevent hanging resources.
		return;
	}

	// Prevent `onError` being called twice.
	readStream.off('error', onError);

	try {
		await streamPipeline(
			readStream,
			createWriteStream('image.png')
		);

		console.log('Success');
	} catch (error) {
		onError(error);
	}
});

readStream.once('error', onError);
```

### `stream.on('downloadProgress', …)`

#### `progress`

**Type: [`Progress`](typescript.md#progress)**

This is emitted on every time `stream.downloadProgress` is updated.

### `stream.on('uploadProgress', …)`

#### `progress`

**Type: [`Progress`](typescript.md#progress)**

This is emitted on every time `stream.uploadProgress` is updated.

<a name="retry"></a>
### `stream.on('retry', …)`

To enable retrying when using streams, a retry handler must be attached.

When this event is emitted, you should reset the stream you were writing to and prepare the body again.

**Note:**
> - [`HTTPError`s](./8-errors.md#httperror) cannot be retried if [`options.throwHttpErrors`](./2-options.md#throwhttperrors) is `false`.
>   This is because stream data is saved to `error.response.body` and streams can be read only once.
> - For the Promise API, there is no such limitation.

#### `retryCount`

**Type: `number`**

The current retry count.

#### `error`

**Type: [`RequestError`](8-errors.md#requesterror)**

The error that caused this retry.

#### `createRetryStream`

**Type: `(options?: OptionsInit) => Request`**

```js
import fs from 'node:fs';
import got from 'got';

let writeStream;

const fn = retryStream => {
	const options = {
		headers: {
			foo: 'bar'
		},
	};

	const stream = retryStream ?? got.stream('https://example.com', options);

	if (writeStream) {
		writeStream.destroy();
	}

	writeStream = fs.createWriteStream('example-com.html');

	stream.pipe(writeStream);

	// If you don't attach the listener, it will NOT make a retry.
	// It automatically checks the listener count so it knows whether to retry or not :)
	stream.once('retry', (retryCount, error, createRetryStream) => {
		fn(createRetryStream()); // or: fn(createRetryStream(optionsToMerge))
	});
};

fn();
```

### `stream.on('redirect', …)`

#### `updatedOptions`

**Type: [`Options`](2-options.md)**

The new options used to make the next request.

#### `response`

**Type: [`IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage)**

The `IncomingMessage` instance the redirect came from.

## Internal usage

This are the functions used internally by Got.\
Other non-documented functions are private and should not be accessible.

### `stream.flush()`

This function is executed automatically by Got. It marks the current stream as ready. If an error occurs before `stream.flush()` is called, it's thrown immediately after `stream.flush()`.

### `stream._beforeError(error)`

This function is called instead `stream.destroy(error)`, required in order to exectue async logic, such as reading the response (e.g. when `ERR_NON_2XX_3XX_RESPONSE` occurs).

### `stream._noPipe`

**Type: `boolean`**

Whether piping is disabled or not. This property is used by the Promise API.

---

## `Response`

Source code: [`source/core/response.ts`](../source/core/response.ts)

**Extends: [`IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage)**

### `requestUrl`

**Type: `URL`**

The original request URL. It is the first argument when calling `got(…)`.

### `redirectUrls`

**Type: `URL[]`**

The redirect URLs.

### `request`

**Type: `Request`**

The underlying Got stream.

### `ip`

**Type: `string`**

The server's IP address.

**Note:**
> - Not available when the response is cached.

### `isFromCache`

**Type: `boolean`**

Whether the response comes from cache or not.

### `ok`

**Type: `boolean`**

Whether the response was successful

**Note:**
> - A request is successful when the status code of the final request is `2xx` or `3xx`.
> - When [following redirects](2-options.md#followredirect), a request is successful **only** when the status code of the final request is `2xx`.
> - `304` responses are always considered successful.
> - Got throws automatically when `response.ok` is `false` and `throwHttpErrors` is `true`.

### `statusCode`

**Type: `number`**

The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status).

### `url`

**Type: `string`**

The final URL after all redirects.

### `timings`

**Type: [`Timings`](typescript.md#timings)**

The same as `request.timings`.

### `retryCount`

**Type: `number`**

The same as `request.retryCount`.

### `rawBody`

**Type: `Buffer`**

**Note:**
> - This property is only accessible when using Promise API.

The raw response body buffer.

### `body`

**Type: `unknown`**

**Note:**
> - This property is only accessible when using Promise API.

The parsed response body.

### `aborted`

**Type: `boolean`**

The same as `request.aborted`.

### `complete`

**Type: `boolean`**

If `true`, the response has been fully parsed.

### `socket`

**Type: `net.Socket | tls.TLSSocket`**

The same as `request.socket`.

### `headers`

**Type: `object<string, string>`**

The [response headers](https://nodejs.org/api/http.html#http_message_headers).

### `statusMessage`

**Type: `string`**

The status message corresponding to the status code.
