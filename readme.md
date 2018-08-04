<div align="center">
	<br>
	<br>
	<img width="360" src="media/logo.svg" alt="Got">
	<br>
	<br>
	<br>
	<p align="center">Huge thanks to <a href="https://moxy.studio"><img src="https://sindresorhus.com/assets/thanks/moxy-logo.svg" width="150"></a> for sponsoring me!
	</p>
	<br>
	<br>
</div>

> Simplified HTTP requests

[![Build Status: Linux](https://travis-ci.org/sindresorhus/got.svg?branch=master)](https://travis-ci.org/sindresorhus/got) [![Build status: Windows](https://ci.appveyor.com/api/projects/status/a9fgfqojj8mf5upf/branch/master?svg=true)](https://ci.appveyor.com/project/sindresorhus/got/branch/master) [![Coverage Status](https://coveralls.io/repos/github/sindresorhus/got/badge.svg?branch=master)](https://coveralls.io/github/sindresorhus/got?branch=master) [![Downloads](https://img.shields.io/npm/dm/got.svg)](https://npmjs.com/got)

A nicer interface to the built-in [`http`](http://nodejs.org/api/http.html) module.

Created because [`request`](https://github.com/request/request) is bloated *(several megabytes!)*.


## Highlights

- [Promise & stream API](#api)
- [Request cancelation](#aborting-the-request)
- [RFC compliant caching](#cache-adapters)
- [Follows redirects](#followredirect)
- [Retries on failure](#retry)
- [Progress events](#onuploadprogress-progress)
- [Handles gzip/deflate](#decompress)
- [Timeout handling](#timeout)
- [Errors with metadata](#errors)
- [JSON mode](#json)
- [WHATWG URL support](#url)
- [Electron support](#useelectronnet)
- [Instances with custom defaults](#instances)


## Install

```
$ npm install got
```

<a href="https://www.patreon.com/sindresorhus">
	<img src="https://c5.patreon.com/external/logo/become_a_patron_button@2x.png" width="160">
</a>


## Usage

```js
const got = require('got');

(async () => {
	try {
		const response = await got('sindresorhus.com');
		console.log(response.body);
		//=> '<!doctype html> ...'
	} catch (error) {
		console.log(error.response.body);
		//=> 'Internal server error ...'
	}
})();
```

###### Streams

```js
const fs = require('fs');
const got = require('got');

got.stream('sindresorhus.com').pipe(fs.createWriteStream('index.html'));

// For POST, PUT, and PATCH methods `got.stream` returns a `stream.Writable`
fs.createReadStream('index.html').pipe(got.stream.post('sindresorhus.com'));
```


### API

It's a `GET` request by default, but can be changed by using different methods or in the `options`.

#### got(url, [options])

Returns a Promise for a `response` object with a `body` property, a `url` property with the request URL or the final URL after redirects, and a `requestUrl` property with the original request URL.

The response object will normally be a [Node.js HTTP response stream](https://nodejs.org/api/http.html#http_class_http_incomingmessage), however if returned from the cache it will be a [responselike object](https://github.com/lukechilds/responselike) which behaves in the same way.

The response will also have a `fromCache` property set with a boolean value.

##### url

Type: `string` `Object`

The URL to request as simple string, a [`https.request` options](https://nodejs.org/api/https.html#https_https_request_options_callback), or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

Properties from `options` will override properties in the parsed `url`.

If no protocol is specified, it will default to `https`.

##### options

Type: `Object`

Any of the [`https.request`](https://nodejs.org/api/https.html#https_https_request_options_callback) options.

###### baseUrl

Type: `string` `Object`

When specified, `url` will be prepended by `baseUrl`.<br>
If you specify an absolute URL, it will skip the `baseUrl`.

Very useful when used with `got.extend()` to create niche-specific `got` instances.

Can be a string or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

###### headers

Type: `Object`<br>
Default: `{}`

Request headers.

Existing headers will be overwritten. Headers set to `null` will be omitted.

###### stream

Type: `boolean`<br>
Default: `false`

Returns a `Stream` instead of a `Promise`. This is equivalent to calling `got.stream(url, [options])`.

###### body

Type: `string` `Buffer` `stream.Readable` [`form-data` instance](https://github.com/form-data/form-data)

*If you provide this option, `got.stream()` will be read-only.*

Body that will be sent with a `POST` request.

If present in `options` and `options.method` is not set, `options.method` will be set to `POST`.

The `content-length` header will be automatically set if `body` is a `string` / `Buffer` / `fs.createReadStream` instance / [`form-data` instance](https://github.com/form-data/form-data), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.

###### encoding

Type: `string` `null`<br>
Default: `'utf8'`

[Encoding](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) to be used on `setEncoding` of the response data. If `null`, the body is returned as a [`Buffer`](https://nodejs.org/api/buffer.html) (binary data).

###### form

Type: `boolean`<br>
Default: `false`

*If you provide this option, `got.stream()` will be read-only.*

If set to `true` and `Content-Type` header is not set, it will be set to `application/x-www-form-urlencoded`.

`body` must be a plain object. It will be converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

###### json

Type: `boolean`<br>
Default: `false`

*If you use `got.stream()`, this option will be ignored.*

If set to `true` and `Content-Type` header is not set, it will be set to `application/json`.

Parse response body with `JSON.parse` and set `accept` header to `application/json`. If used in conjunction with the `form` option, the `body` will the stringified as querystring and the response parsed as JSON.

`body` must be a plain object or array and will be stringified.

###### query

Type: `string` `Object`<br>

Query string object that will be added to the request URL. This will override the query string in `url`.

###### timeout

Type: `number` `Object`

Milliseconds to wait for the server to end the response before aborting request with [`got.TimeoutError`](#gottimeouterror) error (a.k.a. `request` property). By default there's no timeout.

This also accepts an `object` with the following fields to constrain the duration of each phase of the request lifecycle:

- `lookup` starts when a socket is assigned and ends when the hostname has been resolved. Does not apply when using a Unix domain socket.
- `connect` starts when `lookup` completes (or when the socket is assigned if lookup does not apply to the request) and ends when the socket is connected.
- `secureConnect` starts when `connect` completes and ends when the handshaking process completes (HTTPS only).
- `socket` starts when the socket is connected. See [request.setTimeout](https://nodejs.org/api/http.html#http_request_settimeout_timeout_callback).
- `response` starts when the request has been written to the socket and ends when the response headers are received.
- `send` starts when the socket is connected and ends with the request has been written to the socket.
- `request` starts when the request is initiated and ends when the response's end event fires.

###### retry

Type: `number` `Object`<br>
Default:
- retries: `2`
- methods: `GET` `PUT` `HEAD` `DELETE` `OPTIONS` `TRACE`
- statusCodes: [`408`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/408) [`413`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/413) [`429`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429) [`502`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/502) [`503`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/503) [`504`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504)
- maxRetryAfter: `undefined`

Object representing `retries`, `methods`, `statusCodes` and `maxRetryAfter` fields for time until retry, allowed methods, allowed status codes and maximum [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) time.

If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.<br>
If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.

Delays between retries counts with function `1000 * Math.pow(2, retry) + Math.random() * 100`, where `retry` is attempt number (starts from 0).

Option `retries` can be a `number`, but also accepts a `function` with `retry` and `error` arguments. Function must return delay in milliseconds (`0` return value cancels retry).

**Note:** It retries only on the specified methods, status codes, and on these network errors:
- `ETIMEDOUT`: One of the [timeout](#timeout) limits was reached.
- `ECONNRESET`: Connection was forcibly closed by a peer.
- `EADDRINUSE`: Could not bind to any free port.
- `ECONNREFUSED`: Connection was refused by the server.
- `EPIPE`: The remote side of the stream being written has been closed.

###### followRedirect

Type: `boolean`<br>
Default: `true`

Defines if redirect responses should be followed automatically.

Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), got will automatically
request the resource pointed to in the location header via `GET`. This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

###### decompress

Type: `boolean`<br>
Default: `true`

Decompress the response automatically. This will set the `accept-encoding` header to `gzip, deflate` unless you set it yourself.

If this is disabled, a compressed response is returned as a `Buffer`. This may be useful if you want to handle decompression yourself or stream the raw compressed data.

###### cache

Type: `Object`<br>
Default: `false`

[Cache adapter instance](#cache-adapters) for storing cached data.

###### useElectronNet

Type: `boolean`<br>
Default: `false`

When used in Electron, Got will use [`electron.net`](https://electronjs.org/docs/api/net/) instead of the Node.js `http` module. According to the Electron docs, it should be fully compatible, but it's not entirely. See [#443](https://github.com/sindresorhus/got/issues/443) and [#461](https://github.com/sindresorhus/got/issues/461).

###### throwHttpErrors

Type: `boolean`<br>
Default: `true`

Determines if a `got.HTTPError` is thrown for error responses (non-2xx status codes).

If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing. This may be useful if you are checking for resource availability and are expecting error responses.

###### hooks

Type: `Object<string, Array<Function>>`<br>
Default: `{ beforeRequest: [] }`

Hooks allow modifications during the request lifecycle. Hook functions may be async and are run serially.

###### hooks.beforeRequest

Type: `Array<Function>`<br>
Default: `[]`

Called with the normalized request options. Got will make no further changes to the request before it is sent. This is especially useful in conjunction with [`got.extend()`](#instances) and [`got.create()`](advanced-creation.md) when you want to create an API client that uses HMAC-signing.

See the [AWS section](#aws) for an example.

**Note**: Modifying the `body` is not recommended because the `content-length` header has already been computed and assigned.

#### Streams

**Note**: Progress events, redirect events and request/response events can also be used with promises.

#### got.stream(url, [options])

Sets `options.stream` to `true`.

`stream` method will return Duplex stream with additional events:

##### .on('request', request)

`request` event to get the request object of the request.

**Tip**: You can use `request` event to abort request:

```js
got.stream('github.com')
	.on('request', req => setTimeout(() => req.abort(), 50));
```

##### .on('response', response)

`response` event to get the response object of the final request.

##### .on('redirect', response, nextOptions)

`redirect` event to get the response object of a redirect. The second argument is options for the next request to the redirect location.

##### .on('uploadProgress', progress)
##### .on('downloadProgress', progress)

Progress events for uploading (sending request) and downloading (receiving response). The `progress` argument is an object like:

```js
{
	percent: 0.1,
	transferred: 1024,
	total: 10240
}
```

If it's not possible to retrieve the body size (can happen when streaming), `total` will be `null`.

```js
(async () => {
	const response = await got('sindresorhus.com')
		.on('downloadProgress', progress => {
			// Report download progress
		})
		.on('uploadProgress', progress => {
			// Report upload progress
		});

	console.log(response);
})();
```

##### .on('error', error, body, response)

`error` event emitted in case of protocol error (like `ENOTFOUND` etc.) or status error (4xx or 5xx). The second argument is the body of the server response in case of status error. The third argument is response object.

#### got.get(url, [options])
#### got.post(url, [options])
#### got.put(url, [options])
#### got.patch(url, [options])
#### got.head(url, [options])
#### got.delete(url, [options])

Sets `options.method` to the method name and makes a request.

### Instances

#### got.extend([options])

Configure a new `got` instance with default `options`. `options` are merged with the parent instance's `defaults.options` using [`got.mergeOptions`](#gotmergeoptionsparentoptions-newoptions).


```js
const client = got.extend({
	baseUrl: 'https://example.com',
	headers: {
		'x-unicorn': 'rainbow'
	}
});

client.get('/demo');

/* HTTP Request =>
 * GET /demo HTTP/1.1
 * Host: example.com
 * x-unicorn: rainbow
 */
 ```

```js
(async () => {
	const client = got.extend({
		baseUrl: 'httpbin.org',
		headers: {
			'x-foo': 'bar'
		}
	});
	const {headers} = (await client.get('/headers', {json: true})).body;
	//=> headers['x-foo'] === 'bar'

	const jsonClient = client.extend({
		json: true,
		headers: {
			'x-baz': 'qux'
		}
	});
	const {headers: headers2} = (await jsonClient.get('/headers')).body;
	//=> headers2['x-foo'] === 'bar'
	//=> headers2['x-baz'] === 'qux'
})();
```

*Need more control over the behavior of Got? Check out the [`got.create()`](advanced-creation.md).*

#### got.mergeOptions(parentOptions, newOptions)

Extends parent options. Avoid using [object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#Spread_in_object_literals) as it doesn't work recursively:

```js
const a = {headers: {cat: 'meow', wolf: ['bark', 'wrrr']}};
const b = {headers: {cow: 'moo', wolf: ['auuu']}};

{...a, ...b}            // => {headers: {cow: 'moo', wolf: ['auuu']}}
got.mergeOptions(a, b)  // => {headers: {cat: 'meow', cow: 'moo', wolf: ['auuu']}}
```

Options are deeply merged to a new object. The value of each key is determined as follows:

- If the new property is set to `undefined`, it keeps the old one.
- If the parent property is an instance of `URL` and the new value is a `string` or `URL`, a new URL instance is created: [`new URL(new, parent)`](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL#Syntax).
- If the new property is a plain `Object`:
	- If the parent property is a plain `Object` too, both values are merged recursively into a new `Object`.
	- Otherwise, only the new value is deeply cloned.
- If the new property is an `Array`, it overwrites the old one with a deep clone of the new property.
- Otherwise, the new value is assigned to the key.

## Errors

Each error contains (if available) `statusCode`, `statusMessage`, `host`, `hostname`, `method`, `path`, `protocol` and `url` properties to make debugging easier.

In Promise mode, the `response` is attached to the error.

#### got.CacheError

When a cache method fails, for example if the database goes down, or there's a filesystem error.

#### got.RequestError

When a request fails. Contains a `code` property with error class code, like `ECONNREFUSED`.

#### got.ReadError

When reading from response stream fails.

#### got.ParseError

When `json` option is enabled, server response code is 2xx, and `JSON.parse` fails.

#### got.HTTPError

When server response code is not 2xx. Includes `statusCode`, `statusMessage`, and `redirectUrls` properties.

#### got.MaxRedirectsError

When server redirects you more than 10 times. Includes a `redirectUrls` property, which is an array of the URLs Got was redirected to before giving up.

#### got.UnsupportedProtocolError

When given an unsupported protocol.

#### got.CancelError

When the request is aborted with `.cancel()`.

#### got.TimeoutError

When the request is aborted due to a [timeout](#timeout)

## Aborting the request

The promise returned by Got has a [`.cancel()`](https://github.com/sindresorhus/p-cancelable) method which, when called, aborts the request.

```js
(async () => {
	const request = got(url, options);

	…

	// In another part of the code
	if (something) {
		request.cancel();
	}

	…

	try {
		await request;
	} catch (error) {
		if (request.isCanceled) { // Or `error instanceof got.CancelError`
			// Handle cancelation
		}

		// Handle other errors
	}
})();
```

<a name="cache-adapters"></a>
## Cache

Got implements [RFC 7234](http://httpwg.org/specs/rfc7234.html) compliant HTTP caching which works out of the box in memory or is easily pluggable with a wide range of storage adapters. Fresh cache entries are served directly from cache and stale cache entries are revalidated with `If-None-Match`/`If-Modified-Since` headers. You can read more about the underlying cache behaviour in the `cacheable-request` [documentation](https://github.com/lukechilds/cacheable-request).

You can use the JavaScript `Map` type as an in memory cache:

```js
const got = require('got');
const map = new Map();

(async () => {
		let response = await got('sindresorhus.com', {cache: map});
		console.log(response.fromCache);
		//=> false

		response = await got('sindresorhus.com', {cache: map});
		console.log(response.fromCache);
		//=> true
})();
```

Got uses [Keyv](https://github.com/lukechilds/keyv) internally to support a wide range of storage adapters. For something more scalable you could use an [official Keyv storage adapter](https://github.com/lukechilds/keyv#official-storage-adapters):

```
$ npm install @keyv/redis
```

```js
const got = require('got');
const KeyvRedis = require('@keyv/redis');

const redis = new KeyvRedis('redis://user:pass@localhost:6379');

got('sindresorhus.com', {cache: redis});
```

Got supports anything that follows the Map API, so it's easy to write your own storage adapter or use a third-party solution.

For example, the following are all valid storage adapters:

```js
const storageAdapter = new Map();
// or
const storageAdapter = require('./my-storage-adapter');
// or
const QuickLRU = require('quick-lru');
const storageAdapter = new QuickLRU({maxSize: 1000});

got('sindresorhus.com', {cache: storageAdapter});
```

View the [Keyv docs](https://github.com/lukechilds/keyv) for more information on how to use storage adapters.


## Proxies

You can use the [`tunnel`](https://github.com/koichik/node-tunnel) module with the `agent` option to work with proxies:

```js
const got = require('got');
const tunnel = require('tunnel-agent');

got('sindresorhus.com', {
	agent: tunnel.httpOverHttp({
		proxy: {
			host: 'localhost'
		}
	})
});
```

If you require different agents for different protocols, you can pass a map of agents to the `agent` option. This is necessary because a request to one protocol might redirect to another. In such a scenario, `got` will switch over to the right protocol agent for you.

```js
const got = require('got');
const HttpAgent = require('agentkeepalive');
const HttpsAgent = HttpAgent.HttpsAgent;

got('sindresorhus.com', {
	agent: {
		http: new HttpAgent(),
		https: new HttpsAgent()
	}
});
```


## Cookies

You can use the [`cookie`](https://github.com/jshttp/cookie) module to include cookies in a request:

```js
const got = require('got');
const cookie = require('cookie');

got('google.com', {
	headers: {
		cookie: cookie.serialize('foo', 'bar')
	}
});

got('google.com', {
	headers: {
		cookie: [
			cookie.serialize('foo', 'bar'),
			cookie.serialize('fizz', 'buzz')
		].join(';')
	}
});
```


## Form data

You can use the [`form-data`](https://github.com/form-data/form-data) module to create POST request with form data:

```js
const fs = require('fs');
const got = require('got');
const FormData = require('form-data');
const form = new FormData();

form.append('my_file', fs.createReadStream('/foo/bar.jpg'));

got.post('google.com', {
	body: form
});
```


## OAuth

You can use the [`oauth-1.0a`](https://github.com/ddo/oauth-1.0a) module to create a signed OAuth request:

```js
const got = require('got');
const crypto  = require('crypto');
const OAuth = require('oauth-1.0a');

const oauth = OAuth({
	consumer: {
		key: process.env.CONSUMER_KEY,
		secret: process.env.CONSUMER_SECRET
	},
	signature_method: 'HMAC-SHA1',
	hash_function: (baseString, key) => crypto.createHmac('sha1', key).update(baseString).digest('base64')
});

const token = {
	key: process.env.ACCESS_TOKEN,
	secret: process.env.ACCESS_TOKEN_SECRET
};

const url = 'https://api.twitter.com/1.1/statuses/home_timeline.json';

got(url, {
	headers: oauth.toHeader(oauth.authorize({url, method: 'GET'}, token)),
	json: true
});
```


## Unix Domain Sockets

Requests can also be sent via [unix domain sockets](http://serverfault.com/questions/124517/whats-the-difference-between-unix-socket-and-tcp-ip-socket). Use the following URL scheme: `PROTOCOL://unix:SOCKET:PATH`.

- `PROTOCOL` - `http` or `https` *(optional)*
- `SOCKET` - absolute path to a unix domain socket, e.g. `/var/run/docker.sock`
- `PATH` - request path, e.g. `/v2/keys`

```js
got('http://unix:/var/run/docker.sock:/containers/json');

// or without protocol (http by default)
got('unix:/var/run/docker.sock:/containers/json');
```


## AWS

Requests to AWS services need to have their headers signed. This can be accomplished by using the [`aws4`](https://www.npmjs.com/package/aws4) package. This is an example for querying an ["API Gateway"](https://docs.aws.amazon.com/apigateway/api-reference/signing-requests/) with a signed request.

```js
const AWS = require('aws-sdk');
const aws4 = require('aws4');
const got = require('got');

const credentials = await new AWS.CredentialProviderChain().resolvePromise();

// Create a Got instance to use relative paths and signed requests
const awsClient = got.extend(
	{
		baseUrl: 'https://<api-id>.execute-api.<api-region>.amazonaws.com/<stage>/',
		hooks: {
			beforeRequest: [
				async options => {
					await credentials.getPromise();
					aws4.sign(options, credentials);
				}
			]
		}
	}
);

const response = await awsClient('endpoint/path', {
	// Request-specific options
});
```


## Testing

You can test your requests by using the [`nock`](https://github.com/node-nock/nock) module to mock an endpoint:

```js
const got = require('got');
const nock = require('nock');

nock('https://sindresorhus.com')
	.get('/')
	.reply(200, 'Hello world!');

(async () => {
	const response = await got('sindresorhus.com');
	console.log(response.body);
	//=> 'Hello world!'
})();
```

If you need real integration tests you can use [`create-test-server`](https://github.com/lukechilds/create-test-server):

```js
const got = require('got');
const createTestServer = require('create-test-server');

(async () => {
	const server = await createTestServer();
	server.get('/', 'Hello world!');

	const response = await got(server.url);
	console.log(response.body);
	//=> 'Hello world!'

	await server.close();
})();
```


## Tips

### User Agent

It's a good idea to set the `'user-agent'` header so the provider can more easily see how their resource is used. By default, it's the URL to this repo. You can omit this header by setting it to `null`.

```js
const got = require('got');
const pkg = require('./package.json');

got('sindresorhus.com', {
	headers: {
		'user-agent': `my-module/${pkg.version} (https://github.com/username/my-module)`
	}
});

got('sindresorhus.com', {
	headers: {
		'user-agent': null
	}
});
```

### 304 Responses

Bear in mind, if you send an `if-modified-since` header and receive a `304 Not Modified` response, the body will be empty. It's your responsibility to cache and retrieve the body contents.

### Custom endpoints

Use `got.extend()` to make it nicer to work with REST APIs. Especially if you use the `baseUrl` option.

**Note:** Not to be confused with [`got.create()`](advanced-creation.md), which has no defaults.

```js
const got = require('got');
const pkg = require('./package.json');

const custom = got.extend({
	baseUrl: 'example.com',
	json: true,
	headers: {
		'user-agent': `my-module/${pkg.version} (https://github.com/username/my-module)`
	}
});

// Use `custom` exactly how you use `got`
(async () => {
	const list = await custom('/v1/users/list');
})();
```


## Related

- [gh-got](https://github.com/sindresorhus/gh-got) - Got convenience wrapper to interact with the GitHub API
- [gl-got](https://github.com/singapore/gl-got) - Got convenience wrapper to interact with the GitLab API
- [travis-got](https://github.com/samverschueren/travis-got) - Got convenience wrapper to interact with the Travis API
- [graphql-got](https://github.com/kevva/graphql-got) - Got convenience wrapper to interact with GraphQL
- [GotQL](https://github.com/khaosdoctor/gotql) - Got convenience wrapper to interact with GraphQL using JSON-parsed queries instead of strings


## Maintainers

[![Sindre Sorhus](https://github.com/sindresorhus.png?size=100)](https://sindresorhus.com) | [![Vsevolod Strukchinsky](https://github.com/floatdrop.png?size=100)](https://github.com/floatdrop) | [![Alexander Tesfamichael](https://github.com/AlexTes.png?size=100)](https://github.com/AlexTes) | [![Luke Childs](https://github.com/lukechilds.png?size=100)](https://github.com/lukechilds) | [![Szymon Marczak](https://github.com/szmarczak.png?size=100)](https://github.com/szmarczak) | [![Brandon Smith](https://github.com/brandon93s.png?size=100)](https://github.com/brandon93s)
---|---|---|---|---|---
[Sindre Sorhus](https://sindresorhus.com) | [Vsevolod Strukchinsky](https://github.com/floatdrop) | [Alexander Tesfamichael](https://alextes.me) | [Luke Childs](https://github.com/lukechilds) | [Szymon Marczak](https://github.com/szmarczak) | [Brandon Smith](https://github.com/brandon93s)


## License

MIT
