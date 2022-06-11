# Quick start guide

This quick start uses ES2017 syntax.

## Getting and posting data with promises

The simplest `GET` request :

```js
import got from "got";

const url = "https://httpbin.org/anything";
const response = await got(url);
```

The call returns a <code>Promise<[Response](3-streams.md#response-1)></code>. If the body contains json, it can be retreived directly :

```js
const url = "https://httpbin.org/anything";
const data = await got(url).json();
```

The similar <code>[got.text](1-promise.md#promisetext)</code> method returns plain text.

All `got` methods accepts an options object for passing extra informations, such as headers :

```js
const url = "https://httpbin.org/anything";
const options = {
	headers: {
		"Custom-Header": "Quick start",
	},
	timeout: { send: 3500 },
};
const data = await got(url, options).json();
```

A `POST` request is very similar :

```js
const url = "https://httpbin.org/anything";
const options = {
	json: { documentName: "Quick Start" },
};
const data = await got.post(url, options);
```

The request body is passed in the options object, `json` property will automatically set headers accordingly. Custom headers can be added exactly as above.

## Using streams

The [Stream API](3-streams.md) allows to leverage [Node.js Streams](https://nodejs.dev/learn/nodejs-streams) capabilities :

```js
import got from "got";
import fs from "fs";

const url = "https://httpbin.org/anything";
const options = {
	json: { documentName: "Quick Start" },
};
const outStream = fs.createWriteStream("anything.json");
got.stream.post(url, options).pipe(outStream);
```

## Options

Options can be set at client level and reused in subsequent queries :

```js
import got from "got";

const options = {
	prefixUrl: "https://httpbin.org",
	headers: {
		Authorization: getTokenFromVault(),
	},
};
const client = got.extend(options);

export default client;
```

Some noticable common options are (opinionated :blush:) :
 - [searchParams](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#searchparams) : a query string object.
 - [prefixUrl](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#prefixurl) : prepended to query pathes. Pathes must be relative to prefix, i.e. not begin with a `/`.
 - [method](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#method) : the HTTP method name.
 - [headers](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#headers) : query headers.
 - [json](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#json): JSON body.
 - [form](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#form): a form query string object.
 
See documentation for other [options](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md#options).

## Errors

Both Promise and Stream APIs throws error with metadata. They are handled according to the API used.

```js
import got from "got";

const data = await got
	.get("https://httpbin.org/status/404")
	.catch((e) => console.error(e.code, e.message));
```

```js
import got from "got";

got.stream
	.get("https://httpbin.org/status/404")
	.once("error", (e) => console.error(e.code, e.message))
	.pipe(fs.createWriteStream("anything.json"));
```

## Miscalleneous

The HTTP method name can also be given as an option, this may be convenient when it is known only at runtime :

```js
const url = "https://httpbin.org/anything";
const method = "POST";
const options = {
	json: { documentName: "Quick Start" },
	method,
};
const data = await got(url, options);
```

For most applications, http client just do `GET` and `POST` queries (`PUT`, `PATCH` or `DELETE` methods work similarly).
The following sections will give some pointers to more advanced usage.

### Timeouts

By default, requests have no timeout. It is a good practice to set one :

```js
import got from "got";

const options = {
	timeout: {
		request: 10000,
	},
};
const client = got.extend(options);

export default client;
```

The above set a global timeout of 10000 ms for all requests issued by the exported `client`. Like all options, timeouts can also be set at request level. See [timeout options](https://github.com/sindresorhus/got/blob/main/documentation/6-timeout.md#timeout-options).

### Retries

A failed request is retried twice, retry policy may be tuned with a [`retry`](https://github.com/sindresorhus/got/blob/main/documentation/7-retry.md#retry) option object.

```js
const options = {
	retry: {
		limit: 5,
		errorCodes: ["ETIMEDOUT"],
	},
};
```

Retries with stream are a little trickier, see [`stream.on("retry", ...)`](https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#streamonretry-).

### Hooks

Hooks are custom functions called on some request events :

```js
import got from "got";

const logRetry = (error, retryCount) => {
  console.error(`Retrying after error ${error.code}, retry #: ${retryCount}`);
}

const options = {
	hooks: {
		beforeRetry: [logRetry]
	},
};
const client = got.extend(options);

export default client;
```

*Note that handlers are given as arrays*, thus multiple handlers can be given. See documentation for other possible [hooks](https://github.com/sindresorhus/got/blob/main/documentation/9-hooks.md#hooks-api).

### Going further

There's a lot more to discover in the [documentation](https://github.com/sindresorhus/got/blob/main/readme.md#documentation) and [tips](https://github.com/sindresorhus/got/blob/main/documentation/tips.md#tips).
Among others, `Got` can handle [cookies](https://github.com/sindresorhus/got/blob/main/documentation/tips.md#cookies), [pagination](https://github.com/sindresorhus/got/blob/main/documentation/4-pagination.md#pagination-api), [cache](https://github.com/sindresorhus/got/blob/main/documentation/cache.md#cache). Read the doc before implementing something that is already done by `Got` :innocent:.