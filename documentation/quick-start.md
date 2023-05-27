# Quick Start Guide

## Getting and posting data with promises

The simplest `GET` request:

```js
import got from 'got';

const url = 'https://httpbin.org/anything';
const response = await got(url);
```

The call returns a <code>Promise<[Response](3-streams.md#response-1)></code>. If the body contains JSON, it can be retrieved directly:

```js
import got from 'got';

const url = 'https://httpbin.org/anything';
const data = await got(url).json();
```

The similar <code>[got.text](1-promise.md#promisetext)</code> method returns plain text.

All `got` methods accept an options object for passing extra configuration, such as headers:

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

const options = {
	headers: {
		'Custom-Header': 'Quick start',
	},
	timeout: {
		send: 3500
	},
};

const data = await got(url, options).json();
```

A `POST` request is very similar:

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

const options = {
	json: {
		documentName: 'Quick Start',
	},
};

const data = await got.post(url, options);
```

The request body is passed in the options object. The `json` property will automatically set headers accordingly. Custom headers can be added exactly as above.

## Using streams

The [Stream API](3-streams.md) allows to leverage [Node.js Streams](https://nodejs.dev/learn/nodejs-streams) capabilities:

```js
import fs from 'node:fs';
import {pipeline as streamPipeline} from 'node:stream/promises';
import got from 'got';

const url = 'https://httpbin.org/anything';

const options = {
	json: {
		documentName: 'Quick Start',
	},
};

const gotStream = got.stream.post(url, options);

const outStream = fs.createWriteStream('anything.json');

try {
	await streamPipeline(gotStream, outStream);
} catch (error) {
	console.error(error);
}
```

## Options

Options can be set at the client level and reused in subsequent queries:

```js
import got from 'got';

const options = {
	prefixUrl: 'https://httpbin.org',
	headers: {
		Authorization: getTokenFromVault(),
	},
};

const client = got.extend(options);

export default client;
```

Some noticeable common options are:
- [`searchParams`](2-options.md#searchparams): A query string object.
- [`prefixUrl`](2-options.md#prefixurl): Prepended to query paths. Paths must be relative to prefix, i.e. not begin with a `/`.
- [`method`](2-options.md#method): The HTTP method name.
- [`headers`](2-options.md#headers): Query headers.
- [`json`](2-options.md#json): JSON body.
- [`form`](2-options.md#form): A form query string object.

See the documentation for other [options](2-options.md#options).

## Errors

Both Promise and Stream APIs throw errors with metadata.

```js
import got from 'got';

try {
	const data = await got.get('https://httpbin.org/status/404');
} catch (error) {
	console.error(error.response.statusCode);
}
```

```js
import got from 'got';

const stream = got.stream
	.get('https://httpbin.org/status/404')
	.once('error', error => {
		console.error(error.response.statusCode);
	});
```

## Miscellaneous

The HTTP method name can also be given as an option, this may be convenient when it is known only at runtime:

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

const method = 'POST';

const options = {
	method,
	json: {
		documentName: 'Quick Start',
	},
};

const data = await got(url, options);
```

For most apps, HTTP clients just do `GET` and `POST` queries (`PUT`, `PATCH` or `DELETE` methods work similarly).
The following sections will give some pointers to more advanced usage.

### Timeouts

By default, requests have no timeout. It is a good practice to set one:

```js
import got from 'got';

const options = {
	timeout: {
		request: 10000,
	},
};

const client = got.extend(options);

export default client;
```

The above sets a global timeout of 10000 milliseconds for all requests issued by the exported `client`. Like all options, timeouts can also be set at the request level. See the [`timeout` option](6-timeout.md#timeout-options).

### Retries

A failed request is retried twice. The retry policy may be tuned with a [`retry`](7-retry.md#retry) options object.

```js
import got from 'got';

const options = {
	retry: {
		limit: 5,
		errorCodes: [
			'ETIMEDOUT'
		],
	},
};
```

Retries with stream are a little trickier, see [`stream.on('retry', …)`](3-streams.md#streamonretry-).

### Hooks

Hooks are custom functions called on some request events:

```js
import got from 'got';

const logRetry = (error, retryCount) => {
	console.error(`Retrying after error ${error.code}, retry #: ${retryCount}`);
};

const options = {
	hooks: {
		beforeRetry: [
			logRetry,
		],
	},
};

const client = got.extend(options);

export default client;
```

*Note that hooks are given as arrays*, thus multiple hooks can be given. See documentation for other possible [hooks](9-hooks.md#hooks-api).

### Going further

There is a lot more to discover in the [documentation](../readme.md#documentation) and [tips](tips.md#tips). Among others, `Got` can handle [cookies](tips.md#cookies), [pagination](4-pagination.md#pagination-api), [cache](cache.md#cache). Please read the documentation before implementing something that is already done by `Got` :innocent:.
