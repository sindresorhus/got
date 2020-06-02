Œ<div align="center">
	<br>
	<br>
	<img width="360" src="media/logo.svg" alt="Got">
	<br>
	<br>
	<br>
	<p align="center">Huge thanks to <a href="https://moxy.studio"><img src="https://sindresorhus.com/assets/thanks/moxy-logo.svg" width="150"></a> for sponsoring Sindre Sorhus!
	</p>
	<br>
	<br>
</div>

> Human-friendly and powerful HTTP request library for Node.js

[![Build Status: Linux](https://travis-ci.com/sindresorhus/got.svg?branch=master)](https://travis-ci.com/github/sindresorhus/got)
[![Coverage Status](https://coveralls.io/repos/github/sindresorhus/got/badge.svg?branch=master)](https://coveralls.io/github/sindresorhus/got?branch=master)
[![Downloads](https://img.shields.io/npm/dm/got.svg)](https://npmjs.com/got)
[![Install size](https://packagephobia.now.sh/badge?p=got)](https://packagephobia.now.sh/result?p=got)

[Moving from Request?](documentation/migration-guides.md) [*(Note that Request is unmaintained)*](https://github.com/request/request/issues/3142)

[See how Got compares to other HTTP libraries](#comparison)

For browser usage, we recommend [Ky](https://github.com/sindresorhus/ky) by the same people.

## Highlights

- [Promise API](#api)
- [Stream API](#streams)
- [Pagination API](#pagination)
- [HTTP2 support](#http2)
- [Request cancelation](#aborting-the-request)
- [RFC compliant caching](#cache-adapters)
- [Follows redirects](#followredirect)
- [Retries on failure](#retry)
- [Progress events](#onuploadprogress-progress)
- [Handles gzip/deflate/brotli](#decompress)
- [Timeout handling](#timeout)
- [Errors with metadata](#errors)
- [JSON mode](#json-mode)
- [WHATWG URL support](#url)
- [HTTPS API](#https)
- [Hooks](#hooks)
- [Instances with custom defaults](#instances)
- [Types](#types)
- [Composable](documentation/advanced-creation.md#merging-instances)
- [Plugins](documentation/lets-make-a-plugin.md)
- [Used by 4K+ packages and 1.8M+ repos](https://github.com/sindresorhus/got/network/dependents)
- [Actively maintained](https://github.com/sindresorhus/got/graphs/contributors)

## Install

```
$ npm install got
```

## Usage

###### Promise

```js
const got = require('got');

(async () => {
	try {
		const response = await got('https://sindresorhus.com');
		console.log(response.body);
		//=> '<!doctype html> ...'
	} catch (error) {
		console.log(error.response.body);
		//=> 'Internal server error ...'
	}
})();
```

###### JSON

```js
const got = require('got');

(async () => {
	const {body} = await got.post('https://httpbin.org/anything', {
		json: {
			hello: 'world'
		},
		responseType: 'json'
	});

	console.log(body.data);
	//=> {hello: 'world'}
})();
```

See [JSON mode](#json-mode) for more details.

###### Streams

```js
const stream = require('stream');
const {promisify} = require('util');
const fs = require('fs');
const got = require('got');

const pipeline = promisify(stream.pipeline);

(async () => {
    await pipeline(
        got.stream('https://sindresorhus.com'),
        fs.createWriteStream('index.html')
    );

    // For POST, PUT, and PATCH methods `got.stream` returns a `stream.Writable`
    await pipeline(
        fs.createReadStream('index.html'),
        got.stream.post('https://sindresorhus.com')
    );
})();
```

**Tip:** `from.pipe(to)` doesn't forward errors. Instead, use [`stream.pipeline(from, ..., to, callback)`](https://nodejs.org/api/stream.html#stream_stream_pipeline_streams_callback).

### API

It's a `GET` request by default, but can be changed by using different methods or via [`options.method`](#method).

**By default, Got will retry on failure. To disable this option, set [`options.retry`](#retry) to `0`.**

#### got(url?, options?)

Returns a Promise giving a [Response object](#response) or a [Got Stream](#streams-1) if `options.isStream` is set to true.

##### url

Type: `string | object`

The URL to request, as a string, a [`https.request` options object](https://nodejs.org/api/https.html#https_https_request_options_callback), or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

Properties from `options` will override properties in the parsed `url`.

If no protocol is specified, it will throw a `TypeError`.

**Note:** The query string is **not** parsed as search params. Example:

```
got('https://example.com/?query=a b'); //=> https://example.com/?query=a%20b
got('https://example.com/', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b

// The query string is overridden by `searchParams`
got('https://example.com/?query=a b', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b
```

##### options

Type: `object`

Any of the [`https.request`](https://nodejs.org/api/https.html#https_https_request_options_callback) options.

**Note:** Legacy URL support is disabled. `options.path` is supported only for backwards compatibility. Use `options.pathname` and `options.searchParams` instead. `options.auth` has been replaced with `options.username` & `options.password`.

###### method

Type: `string`\
Default: `GET`

The HTTP method used to make the request.

###### prefixUrl

Type: `string | URL`

When specified, `prefixUrl` will be prepended to `url`. The prefix can be any valid URL, either relative or absolute.\
A trailing slash `/` is optional - one will be added automatically.

**Note:** `prefixUrl` will be ignored if the `url` argument is a URL instance.

**Note:** Leading slashes in `input` are disallowed when using this option to enforce consistency and avoid confusion. For example, when the prefix URL is `https://example.com/foo` and the input is `/bar`, there's ambiguity whether the resulting URL would become `https://example.com/foo/bar` or `https://example.com/bar`. The latter is used by browsers.

**Tip:** Useful when used with [`got.extend()`](#custom-endpoints) to create niche-specific Got instances.

**Tip:** You can change `prefixUrl` using hooks as long as the URL still includes the `prefixUrl`. If the URL doesn't include it anymore, it will throw.

```js
const got = require('got');

(async () => {
	await got('unicorn', {prefixUrl: 'https://cats.com'});
	//=> 'https://cats.com/unicorn'

	const instance = got.extend({
		prefixUrl: 'https://google.com'
	});

	await instance('unicorn', {
		hooks: {
			beforeRequest: [
				options => {
					options.prefixUrl = 'https://cats.com';
				}
			]
		}
	});
	//=> 'https://cats.com/unicorn'
})();
```

###### headers

Type: `object`\
Default: `{}`

Request headers.

Existing headers will be overwritten. Headers set to `undefined` will be omitted.

###### isStream

Type: `boolean`\
Default: `false`

Returns a `Stream` instead of a `Promise`. This is equivalent to calling `got.stream(url, options?)`.

###### body

Type: `string | Buffer | stream.Readable` or [`form-data` instance](https://github.com/form-data/form-data)

**Note #1:** The `body` option cannot be used with the `json` or `form` option.

**Note #2:** If you provide this option, `got.stream()` will be read-only.

**Note #3:** If you provide a payload with the `GET` or `HEAD` method, it will throw a `TypeError` unless the method is `GET` and the `allowGetBody` option is set to `true`.

**Note #4:** This option is not enumerable and will not be merged with the instance defaults.

The `content-length` header will be automatically set if `body` is a `string` / `Buffer` / `fs.createReadStream` instance / [`form-data` instance](https://github.com/form-data/form-data), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.

###### json

Type: `object | Array | number | string | boolean | null` *(JSON-serializable values)*

**Note #1:** If you provide this option, `got.stream()` will be read-only.\
**Note #2:** This option is not enumerable and will not be merged with the instance defaults.

JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.

###### context

Type: `object`

User data. In contrast to other options, `context` is not enumerable.

**Note:** The object is never merged, it's just passed through. Got will not modify the object in any way.

It's very useful for storing auth tokens:

```js
const got = require('got');

const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				if (!options.context || !options.context.token) {
					throw new Error('Token required');
				}

				options.headers.token = options.context.token;
			}
		]
	}
});

(async () => {
	const context = {
		token: 'secret'
	};

	const response = await instance('https://httpbin.org/headers', {context});

	// Let's see the headers
	console.log(response.body);
})();
```

###### responseType

Type: `string`\
Default: `'text'`

**Note:** When using streams, this option is ignored.

The parsing method. Can be `'text'`, `'json'` or `'buffer'`.

The promise also has `.text()`, `.json()` and `.buffer()` methods which return another Got promise for the parsed body.\
It's like setting the options to `{responseType: 'json', resolveBodyOnly: true}` but without affecting the main Got promise.

Example:

```js
(async () => {
	const responsePromise = got(url);
	const bufferPromise = responsePromise.buffer();
	const jsonPromise = responsePromise.json();

	const [response, buffer, json] = Promise.all([responsePromise, bufferPromise, jsonPromise]);
	// `response` is an instance of Got Response
	// `buffer` is an instance of Buffer
	// `json` is an object
})();
```

```js
// This
const body = await got(url).json();

// is semantically the same as this
const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
```

###### parseJson

Type: `(text: string) => unknown`\
Default: `(text: string) => JSON.parse(text)`

Function used to parse JSON responses.

Example:

```js
const got = require('got');
const Bourne = require('@hapi/bourne');

const parsed = await got('https://example.com', {
	parseJson: text => Bourne.parse(text)
}).json();
```

###### stringifyJson

Type: `(object: any) => string`\
Default: `(object: any) => JSON.stringify(object)`

Function used to stringify JSON requests body.

Example:

```js
const got = require('got');

await got.post('https://example.com', {
	stringifyJson: object => JSON.stringify(object),
	json: {
		some: 'payload'
	}
});
```

###### resolveBodyOnly

Type: `boolean`\
Default: `false`

When set to `true` the promise will return the [Response body](#body-1) instead of the [Response](#response) object.

###### cookieJar

Type: `object` | [`tough.CookieJar` instance](https://github.com/salesforce/tough-cookie#cookiejar)

**Note:** If you provide this option, `options.headers.cookie` will be overridden.

Cookie support. You don't have to care about parsing or how to store them. [Example](#cookies).

###### cookieJar.setCookie

Type: `Function<Promise>`

The function takes two arguments: `rawCookie` (`string`) and `url` (`string`).

###### cookieJar.getCookieString

Type: `Function<Promise>`

The function takes one argument: `url` (`string`).

###### ignoreInvalidCookies

Type: `boolean`\
Default: `false`

Ignore invalid cookies instead of throwing an error. Only useful when the `cookieJar` option has been set. Not recommended.

###### encoding

Type: `string`\
Default: `'utf8'`

[Encoding](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) to be used on `setEncoding` of the response data.

To get a [`Buffer`](https://nodejs.org/api/buffer.html), you need to set [`responseType`](#responseType) to `buffer` instead.

**Note:** This doesn't affect streams! Instead, you need to do `got.stream(...).setEncoding(encoding)`.

###### form

Type: `object`

**Note #1:** If you provide this option, `got.stream()` will be read-only.\
**Note #2:** This option is not enumerable and will not be merged with the instance defaults.

The form body is converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

If the `Content-Type` header is not present, it will be set to `application/x-www-form-urlencoded`.

###### searchParams

Type: `string | object<string, string | number> | URLSearchParams`

Query string that will be added to the request URL. This will override the query string in `url`.

If you need to pass in an array, you can do it using a `URLSearchParams` instance:

```js
const got = require('got');

const searchParams = new URLSearchParams([['key', 'a'], ['key', 'b']]);

got('https://example.com', {searchParams});

console.log(searchParams.toString());
//=> 'key=a&key=b'
```

###### timeout

Type: `number | object`

Milliseconds to wait for the server to end the response before aborting the request with [`got.TimeoutError`](#gottimeouterror) error (a.k.a. `request` property). By default, there's no timeout.

This also accepts an `object` with the following fields to constrain the duration of each phase of the request lifecycle:

- `lookup` starts when a socket is assigned and ends when the hostname has been resolved. Does not apply when using a Unix domain socket.
- `connect` starts when `lookup` completes (or when the socket is assigned if lookup does not apply to the request) and ends when the socket is connected.
- `secureConnect` starts when `connect` completes and ends when the handshaking process completes (HTTPS only).
- `socket` starts when the socket is connected. See [request.setTimeout](https://nodejs.org/api/http.html#http_request_settimeout_timeout_callback).
- `response` starts when the request has been written to the socket and ends when the response headers are received.
- `send` starts when the socket is connected and ends with the request has been written to the socket.
- `request` starts when the request is initiated and ends when the response's end event fires.

###### retry

Type: `number | object`\
Default:
- limit: `2`
- calculateDelay: `({attemptCount, retryOptions, error, computedValue}) => computedValue | Promise<computedValue>`
- methods: `GET` `PUT` `HEAD` `DELETE` `OPTIONS` `TRACE`
- statusCodes: [`408`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/408) [`413`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/413) [`429`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429) [`500`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500) [`502`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/502) [`503`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/503) [`504`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504) [`521`](https://support.cloudflare.com/hc/en-us/articles/115003011431#521error) [`522`](https://support.cloudflare.com/hc/en-us/articles/115003011431#522error) [`524`](https://support.cloudflare.com/hc/en-us/articles/115003011431#524error)
- maxRetryAfter: `undefined`
- errorCodes: `ETIMEDOUT` `ECONNRESET` `EADDRINUSE` `ECONNREFUSED` `EPIPE` `ENOTFOUND` `ENETUNREACH` `EAI_AGAIN`

An object representing `limit`, `calculateDelay`, `methods`, `statusCodes`, `maxRetryAfter` and `errorCodes` fields for maximum retry count, retry handler, allowed methods, allowed status codes, maximum [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) time and allowed error codes.

**Note:** When using streams, this option is ignored. If the connection is reset when downloading, you need to catch the error and clear the file you were writing into to prevent duplicated content.

If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.\
If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.

Delays between retries counts with function `1000 * Math.pow(2, retry) + Math.random() * 100`, where `retry` is attempt number (starts from 1).

The `calculateDelay` property is a `function` that receives an object with `attemptCount`, `retryOptions`, `error` and `computedValue` properties for current retry count, the retry options, error and default computed value. The function must return a delay in milliseconds (or a Promise resolving with it) (`0` return value cancels retry).

By default, it retries *only* on the specified methods, status codes, and on these network errors:
- `ETIMEDOUT`: One of the [timeout](#timeout) limits were reached.
- `ECONNRESET`: Connection was forcibly closed by a peer.
- `EADDRINUSE`: Could not bind to any free port.
- `ECONNREFUSED`: Connection was refused by the server.
- `EPIPE`: The remote side of the stream being written has been closed.
- `ENOTFOUND`: Couldn't resolve the hostname to an IP address.
- `ENETUNREACH`: No internet connection.
- `EAI_AGAIN`: DNS lookup timed out.

###### followRedirect

Type: `boolean`\
Default: `true`

Defines if redirect responses should be followed automatically.

Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), Got will automatically request the resource pointed to in the location header via `GET`. This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

###### methodRewriting

Type: `boolean`\
Default: `true`

By default, redirects will use [method rewriting](https://tools.ietf.org/html/rfc7231#section-6.4). For example, when sending a POST request and receiving a `302`, it will resend the body to the new location using the same HTTP method (`POST` in this case).

###### allowGetBody

Type: `boolean`\
Default: `false`

**Note:** The [RFC 7321](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore **it's considered an [anti-pattern](https://en.wikipedia.org/wiki/Anti-pattern)**.

Set this to `true` to allow sending body for the `GET` method. However, the [HTTP/2 specification](https://tools.ietf.org/html/rfc7540#section-8.1.3) says that `An HTTP GET request includes request header fields and no payload body`, therefore when using the HTTP/2 protocol this option will have no effect. This option is only meant to interact with non-compliant servers when you have no other choice.

###### maxRedirects

Type: `number`\
Default: `10`

If exceeded, the request will be aborted and a `MaxRedirectsError` will be thrown.

###### decompress

Type: `boolean`\
Default: `true`

Decompress the response automatically. This will set the `accept-encoding` header to `gzip, deflate, br` on Node.js 11.7.0+ or `gzip, deflate` for older Node.js versions, unless you set it yourself.

Brotli (`br`) support requires Node.js 11.7.0 or later.

If this is disabled, a compressed response is returned as a `Buffer`. This may be useful if you want to handle decompression yourself or stream the raw compressed data.

###### cache

Type: `object | false`\
Default: `false`

[Cache adapter instance](#cache-adapters) for storing cached response data.

###### dnsCache

Type: `CacheableLookup | false`\
Default: `false`

An instance of [`CacheableLookup`](https://github.com/szmarczak/cacheable-lookup) used for making DNS lookups. Useful when making lots of requests to different *public* hostnames.

**Note:** This should stay disabled when making requests to internal hostnames such as `localhost`, `database.local` etc.\
`CacheableLookup` uses `dns.resolver4(..)` and `dns.resolver6(...)` under the hood and fall backs to `dns.lookup(...)` when the first two fail, which may lead to additional delay.

###### dnsLookupIpVersion

Type: `'auto' | 'ipv4' | 'ipv6'`\
Default: `'auto'`

Indicates which DNS record family to use.\
Values:
 - `auto`: IPv4 (if present) or IPv6
 - `ipv4`: Only IPv4
 - `ipv6`: Only IPv6

Note: If you are using the undocumented option `family`, `dnsLookupIpVersion` will override it.

```js
// `api6.ipify.org` will be resolved as IPv4 and the request will be over IPv4 (the website will respond with your public IPv4)
await got('https://api6.ipify.org', {
	dnsLookupIpVersion: 'ipv4'
});

// `api6.ipify.org` will be resolved as IPv6 and the request will be over IPv6 (the website will respond with your public IPv6)
await got('https://api6.ipify.org', {
	dnsLookupIpVersion: 'ipv6'
});
```

###### request

Type: `Function`\
Default: `http.request | https.request` *(Depending on the protocol)*

Custom request function. The main purpose of this is to [support HTTP2 using a wrapper](https://github.com/szmarczak/http2-wrapper).

###### http2

Type: `boolean`\
Default: `false`

If set to `true`, Got will additionally accept HTTP2 requests.\
It will choose either HTTP/1.1 or HTTP/2 depending on the ALPN protocol.

**Note:** Overriding `options.request` will disable HTTP2 support.

**Note:** This option will default to `true` in the next upcoming major release.

```js
const got = require('got');

(async () => {
	const {headers} = await got('https://nghttp2.org/httpbin/anything', {http2: true});
	console.log(headers.via);
	//=> '2 nghttpx'
})();
```

###### throwHttpErrors

Type: `boolean`\
Default: `true`

Determines if a [`got.HTTPError`](#gothttperror) is thrown for unsuccessful responses.

If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing. This may be useful if you are checking for resource availability and are expecting error responses.

###### agent

Type: `object`

An object representing `http`, `https` and `http2` keys for [`http.Agent`](https://nodejs.org/api/http.html#http_class_http_agent), [`https.Agent`](https://nodejs.org/api/https.html#https_class_https_agent) and [`http2wrapper.Agent`](https://github.com/szmarczak/http2-wrapper#new-http2agentoptions) instance. This is necessary because a request to one protocol might redirect to another. In such a scenario, Got will switch over to the right protocol agent for you.

If a key is not present, it will default to a global agent.

```js
const got = require('got');
const HttpAgent = require('agentkeepalive');
const {HttpsAgent} = HttpAgent;

got('https://sindresorhus.com', {
	agent: {
		http: new HttpAgent(),
		https: new HttpsAgent()
	}
});
```

###### hooks

Type: `object<string, Function[]>`

Hooks allow modifications during the request lifecycle. Hook functions may be async and are run serially.

###### hooks.init

Type: `Function[]`\
Default: `[]`

Called with plain [request options](#options), right before their normalization. This is especially useful in conjunction with [`got.extend()`](#instances) when the input needs custom handling.

See the [Request migration guide](documentation/migration-guides.md#breaking-changes) for an example.

**Note #1:** This hook must be synchronous!\
**Note #2:** Errors in this hook will be converted into an instances of [`RequestError`](#got.requesterror).\
**Note #3:** The options object may not have a `url` property. To modify it, use a `beforeRequest` hook instead.

###### hooks.beforeRequest

Type: `Function[]`\
Default: `[]`

Called with [normalized](source/core/index.ts) [request options](#options). Got will make no further changes to the request before it is sent. This is especially useful in conjunction with [`got.extend()`](#instances) when you want to create an API client that, for example, uses HMAC-signing.

See the [AWS section](#aws) for an example.

###### hooks.beforeRedirect

Type: `Function[]`\
Default: `[]`

Called with [normalized](source/core/index.ts) [request options](#options) and the redirect [response](#response). Got will make no further changes to the request. This is especially useful when you want to avoid dead sites. Example:

```js
const got = require('got');

got('https://example.com', {
	hooks: {
		beforeRedirect: [
			(options, response) => {
				if (options.hostname === 'deadSite') {
					options.hostname = 'fallbackSite';
				}
			}
		]
	}
});
```

###### hooks.beforeRetry

Type: `Function[]`\
Default: `[]`

**Note:** When using streams, this hook is ignored.

Called with [normalized](source/normalize-arguments.ts) [request options](#options), the error and the retry count. Got will make no further changes to the request. This is especially useful when some extra work is required before the next try. Example:

```js
const got = require('got');

got.post('https://example.com', {
	hooks: {
		beforeRetry: [
			(options, error, retryCount) => {
				if (error.response.statusCode === 413) { // Payload too large
					options.body = getNewBody();
				}
			}
		]
	}
});
```

**Note:** When retrying in a `afterResponse` hook, all remaining `beforeRetry` hooks will be called without the `error` and `retryCount` arguments.

###### hooks.afterResponse

Type: `Function[]`\
Default: `[]`

**Note:** When using streams, this hook is ignored.

Called with [response object](#response) and a retry function. Calling the retry function will trigger `beforeRetry` hooks.

Each function should return the response. This is especially useful when you want to refresh an access token. Example:

```js
const got = require('got');

const instance = got.extend({
	hooks: {
		afterResponse: [
			(response, retryWithMergedOptions) => {
				if (response.statusCode === 401) { // Unauthorized
					const updatedOptions = {
						headers: {
							token: getNewToken() // Refresh the access token
						}
					};

					// Save for further requests
					instance.defaults.options = got.mergeOptions(instance.defaults.options, updatedOptions);

					// Make a new retry
					return retryWithMergedOptions(updatedOptions);
				}

				// No changes otherwise
				return response;
			}
		],
		beforeRetry: [
			(options, error, retryCount) => {
				// This will be called on `retryWithMergedOptions(...)`
			}
		]
	},
	mutableDefaults: true
});
```

###### hooks.beforeError

Type: `Function[]`\
Default: `[]`

Called with an `Error` instance. The error is passed to the hook right before it's thrown. This is especially useful when you want to have more detailed errors.

**Note:** Errors thrown while normalizing input options are thrown directly and not part of this hook.

```js
const got = require('got');

got('https://api.github.com/some-endpoint', {
	hooks: {
		beforeError: [
			error => {
				const {response} = error;
 				if (response && response.body) {
					error.name = 'GitHubError';
					error.message = `${response.body.message} (${response.statusCode})`;
				}

 				return error;
			}
		]
	}
});
```

##### pagination

Type: `object`

**Note:** We're [looking for feedback](https://github.com/sindresorhus/got/issues/1052), any ideas on how to improve the API are welcome.

###### pagination.transform

Type: `Function`\
Default: `response => JSON.parse(response.body)`

A function that transform [`Response`](#response) into an array of items. This is where you should do the parsing.

###### pagination.paginate

Type: `Function`\
Default: [`Link` header logic](source/index.ts)

The function takes three arguments:
- `response` - The current response object.
- `allItems` - An array of the emitted items.
- `currentItems` - Items from the current response.

It should return an object representing Got options pointing to the next page. The options are merged automatically with the previous request, therefore the options returned `pagination.paginate(...)` must reflect changes only. If there are no more pages, `false` should be returned.

For example, if you want to stop when the response contains less items than expected, you can use something like this:

```js
const got = require('got');

(async () => {
	const limit = 10;

	const items = got.paginate('https://example.com/items', {
		searchParams: {
			limit,
			offset: 0
		},
		pagination: {
			paginate: (response, allItems, currentItems) => {
				const previousSearchParams = response.request.options.searchParams;
				const previousOffset = previousSearchParams.get('offset');

				if (currentItems.length < limit) {
					return false;
				}

				return {
					searchParams: {
						...previousSearchParams,
						offset: Number(previousOffset) + limit,
					}
				};
			}
		}
	});

	console.log('Items from all pages:', items);
})();
```

###### pagination.filter

Type: `Function`\
Default: `(item, allItems, currentItems) => true`

Checks whether the item should be emitted or not.

###### pagination.shouldContinue

Type: `Function`\
Default: `(item, allItems, currentItems) => true`

Checks whether the pagination should continue.

For example, if you need to stop **before** emitting an entry with some flag, you should use `(item, allItems, currentItems) => !item.flag`. If you want to stop **after** emitting the entry, you should use `(item, allItems, currentItems) => allItems.some(entry => entry.flag)` instead.

###### pagination.countLimit

Type: `number`\
Default: `Infinity`

The maximum amount of items that should be emitted.

###### pagination.requestLimit

Type: `number`\
Default: `10000`

The maximum amount of request that should be triggered. [Retries on failure](#retry) are not counted towards this limit.

For example, it can be helpful during development to avoid an infinite number of requests.

###### pagination.stackAllItems

Type: `boolean`\
Default: `true`

Defines how the parameter `allItems` in [pagination.paginate](#pagination.paginate), [pagination.filter](#pagination.filter) and [pagination.shouldContinue](#pagination.shouldContinue) is managed. When set to `false`, the parameter `allItems` is always an empty array.

This option can be helpful to save on memory usage when working with a large dataset.

##### localAddress

Type: `string`

The IP address used to send the request from.

### Advanced HTTPS API

Note: If the request is not HTTPS, these options will be ignored.

##### https.certificateAuthority

Type: `string | Buffer | Array<string | Buffer>`

Override the default Certificate Authorities ([from Mozilla](https://ccadb-public.secure.force.com/mozilla/IncludedCACertificateReport))

```js
// Single Certificate Authority
got('https://example.com', {
	https: {
		certificateAuthority: fs.readFileSync('./my_ca.pem')
	}
});
```

##### https.key

Type: `string | Buffer | Array<string | Buffer> | object[]`

Private keys in [PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) format.\
[PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) allows the option of private keys being encrypted. Encrypted keys will be decrypted with `options.https.passphrase`.\
Multiple keys with different passphrases can be provided as an array of `{pem: <string | Buffer>, passphrase: <string>}`

##### https.certificate

Type: `string | Buffer | (string | Buffer)[]`

[Certificate chains](https://en.wikipedia.org/wiki/X.509#Certificate_chains_and_cross-certification) in [PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) format.\
One cert chain should be provided per private key (`options.https.key`).\
When providing multiple cert chains, they do not have to be in the same order as their private keys in `options.https.key`.\
If the intermediate certificates are not provided, the peer will not be able to validate the certificate, and the handshake will fail.

##### https.passphrase

Type: `string`

The passphrase to decrypt the `options.https.key` (if different keys have different passphrases refer to `options.https.key` documentation).

##### Examples for `https.key`, `https.certificate` and `https.passphrase`

```js
// Single key with certificate
got('https://example.com', {
	https: {
		key: fs.readFileSync('./client_key.pem'),
		certificate: fs.readFileSync('./client_cert.pem')
	}
});

// Multiple keys with certificates (out of order)
got('https://example.com', {
	https: {
		key: [
			fs.readFileSync('./client_key1.pem'),
			fs.readFileSync('./client_key2.pem')
		],
		certificate: [
			fs.readFileSync('./client_cert2.pem'),
			fs.readFileSync('./client_cert1.pem')
		]
	}
});

// Single key with passphrase
got('https://example.com', {
	https: {
		key: fs.readFileSync('./client_key.pem'),
		certificate: fs.readFileSync('./client_cert.pem'),
		passphrase: 'client_key_passphrase'
	}
});

// Multiple keys with different passphrases
got('https://example.com', {
	https: {
		key: [
			{pem: fs.readFileSync('./client_key1.pem'), passphrase: 'passphrase1'},
			{pem: fs.readFileSync('./client_key2.pem'), passphrase: 'passphrase2'},
		],
		certificate: [
			fs.readFileSync('./client_cert1.pem'),
			fs.readFileSync('./client_cert2.pem')
		]
	}
});
```

##### https.rejectUnauthorized

Type: `boolean`\
Default: `true`

If set to `false`, all invalid SSL certificates will be ignored and no error will be thrown.\
If set to `true`, it will throw an error whenever an invalid SSL certificate is detected.

We strongly recommend to have this set to `true` for security reasons.

```js
const got = require('got');

(async () => {
	// Correct:
	await got('https://example.com', {
		https: {
			rejectUnauthorized: true
		}
	});

	// You can disable it when developing an HTTPS app:
	await got('https://localhost', {
		https: {
			rejectUnauthorized: false
		}
	});

	// Never do this:
	await got('https://example.com', {
		https: {
			rejectUnauthorized: false
		}
	});
```

##### https.checkServerIdentity

Type: `Function`\
Signature: `(hostname: string, certificate: DetailedPeerCertificate) => Error | undefined`\
Default: `tls.checkServerIdentity` (from the `tls` module)

This function enable a custom check of the certificate.\
Note: In order to have the function called the certificate must not be `expired`, `self-signed` or with an `untrusted-root`.\
The function parameters are:
- `hostname`: The server hostname (used when connecting)
- `certificate`: The server certificate

The function must return `undefined` if the check succeeded or an `Error` if it failed.

```js
await got('https://example.com', {
	https: {
		checkServerIdentity: (hostname, certificate) => {
			if (hostname === 'example.com') {
				return; // Certificate OK
			}
			
			return new Error('Invalid Hostname'); // Certificate NOT OK
		}
	}
});
```

#### Response

The response object will typically be a [Node.js HTTP response stream](https://nodejs.org/api/http.html#http_class_http_incomingmessage), however, if retur
