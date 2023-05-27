[> Back to homepage](../readme.md#documentation)

## Options

Source code: [`source/core/options.ts`](../source/core/options.ts)

Like `fetch` stores the options in a `Request` instance, Got does so in `Options`.\
It is made of getters and setters that provide fast option normalization and validation.

**By default, Got will retry on failure. To disable this option, set [`options.retry`](7-retry.md) to `{limit: 0}`.**

#### Merge behavior explained

When an option is already set, setting it again replaces it with a deep clone by default.\
Otherwise the merge behavior is documented in the corresponding section for the option.

#### How to store options

The constructor - `new Options(url, options, defaults)` - takes the same arguments like the `got` function.

```js
import got, {Options} from 'got';

const options = new Options({
	prefixUrl: 'https://httpbin.org',
	headers: {
		foo: 'foo'
	}
});

options.headers.foo = 'bar';

// Note that `Options` stores normalized options, therefore it needs to be passed as the third argument.
const {headers} = await got('anything', undefined, options).json();
console.log(headers.Foo);
//=> 'bar'
```

If a plain object is preferred, it can be used in the following way:

```js
import got from 'got';

const options = {
	prefixUrl: 'https://httpbin.org',
	headers: {
		foo: 'bar'
	}
};

options.headers.foo = 'bar';

// Note that `options` is a plain object, therefore it needs to be passed as the second argument.
const {headers} = await got('anything', options).json();
console.log(headers.Foo);
//=> 'bar'
```

Note that the constructor throws when an invalid option is provided, such as non-existing option or a typo.\
In the second example, it would throw only when the promise is being executed.

For TypeScript users, `got` exports a dedicated type called `OptionsInit`.\
It is a plain object that can store the same properties as `Options`.

Performance-wise there is no difference which one is used, although the constructor may be preferred as it automatically validates the data.\
The `Options` approach may give a slight boost as it only clones the options, there is no normalization going on.\
It is also useful for storing the base configuration of a custom Got client.

#### Resetting options

Unlike Got 11, explicitly specifying `undefined` no longer keeps the parent value.\
In order to keep the parent value, you must not set an option to `undefined`.\
Doing so will reset those values:

```js
instance(…, {searchParams: undefined}});
instance(…, {cookieJar: undefined}});
instance(…, {responseType: undefined}});
instance(…, {prefixUrl: ''});
instance(…, {agent: {http: undefined, https: undefined, http2: undefined}});
instance(…, {context: {token: undefined, …}});
instance(…, {https: {rejectUnauthorized: undefined, …}});
instance(…, {cacheOptions: {immutableMinTimeToLive: undefined, …}});
instance(…, {headers: {'user-agent': undefined, …}});
instance(…, {timeout: {request: undefined, …}});
```

In order to reset `hooks`, `retry` and `pagination`, another Got instance must be created:

```js
const defaults = new Options();

const secondInstance = instance.extend({mutableDefaults: true});
secondInstance.defaults.options.hooks = defaults.hooks;
secondInstance.defaults.options.retry = defaults.retry;
secondInstance.defaults.options.pagination = defaults.pagination;
```

### `url`

**Type: <code>string | [URL](https://nodejs.org/api/url.html#url_the_whatwg_url_api)</code>**

The URL to request. Usually the `url` represents a [WHATWG URL](https://url.spec.whatwg.org/#url-class).

```js
import got from 'got';

// This:
await got('https://httpbin.org/anything');

// is semantically the same as this:
await got(new URL('https://httpbin.org/anything'));

// as well as this:
await got({
	url: 'https://httpbin.org/anything'
});
```

#### **Note:**
> - Throws if no protocol specified.

#### **Note:**
> - If `url` is a string, then the `query` string will **not** be parsed as search params.\
>  This is in accordance to [the specification](https://datatracker.ietf.org/doc/html/rfc7230#section-2.7).\
>  If you want to pass search params instead, use the `searchParams` option below.

```js
import got from 'got';

await got('https://httpbin.org/anything?query=a b'); //=> ?query=a%20b
await got('https://httpbin.org/anything', {searchParams: {query: 'a b'}}); //=> ?query=a+b

// The query string is overridden by `searchParams`
await got('https://httpbin.org/anything?query=a b', {searchParams: {query: 'a b'}}); //=> ?query=a+b
```

#### **Note:**
> - Leading slashes are disallowed to enforce consistency and avoid confusion.\
>  For example, when the prefix URL is `https://example.com/foo` and the input is `/bar`, there's ambiguity whether the resulting URL would become `https://example.com/foo/bar` or `https://example.com/bar`. The latter is used by browsers.

### `searchParams`

**Type: <code>string | [URLSearchParams](https://nodejs.org/api/url.html#url_class_urlsearchparams) | object&lt;string, [Primitive](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>**

[WHATWG URL Search Params](https://url.spec.whatwg.org/#interface-urlsearchparams) to be added to the request URL.

```js
import got from 'got';

const response = await got('https://httpbin.org/anything', {
	searchParams: {
		hello: 'world',
		foo: 123
	}
}).json();

console.log(response.args);
//=> {hello: 'world', foo: 123}
```

If you need to pass an array, you can do it using a `URLSearchParams` instance:

```js
import got from 'got';

const searchParams = new URLSearchParams([['key', 'a'], ['key', 'b']]);

await got('https://httpbin.org/anything', {searchParams});

console.log(searchParams.toString());
//=> 'key=a&key=b'
```

#### **Note:**
> - This will override the `query` string in `url`.

#### **Note:**
> - `null` values are not stringified, an empty string is used instead.
> - `undefined` values will clear the original keys.

#### **Merge behavior:**
> - Overrides existing properties.

### `prefixUrl`

**Type: `string`**\
**Default: `''`**

The string to be prepended to `url`.

The prefix can be any valid URL, either relative or [absolute](https://url.spec.whatwg.org/#absolute-url-string).
A trailing slash `/` is optional - one will be added automatically.

```js
import got from 'got';

// This:
const instance = got.extend({prefixUrl: 'https://httpbin.org'});
await instance('anything');

// is semantically the same as this:
await got('https://httpbin.org/anything');
```

#### **Note:**
> - Changing `prefixUrl` also updates the `url` option if set.

#### **Note:**
> - If you're passing an absolute URL as `url`, you need to set `prefixUrl` to an empty string.

### `signal`

**Type: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)**

You can abort the `request` using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

```js
import got from 'got';

const abortController = new AbortController();

const request = got('https://httpbin.org/anything', {
	signal: abortController.signal
});

setTimeout(() => {
	abortController.abort();
}, 100);
```

### `method`

**Type: `string`**\
**Default: `GET`**

The [HTTP method](https://datatracker.ietf.org/doc/html/rfc7231#section-4) used to make the request.\
The most common methods are: `GET`, `HEAD`, `POST`, `PUT`, `DELETE`.

```js
import got from 'got';

const {method} = await got('https://httpbin.org/anything', {
	method: 'POST'
}).json();

console.log(method);
// => 'POST'
```

### `headers`

**Type: `object<string, string>`**\
**Default: `{}`**

The [HTTP headers](https://datatracker.ietf.org/doc/html/rfc7231#section-8.3) to be sent. Headers set to `undefined` will be omitted.

```js
import got from 'got';

const {headers} = await got.post('https://httpbin.org/anything', {
	headers: {
		hello: 'world'
	}
}).json();

console.log(headers);
// => {hello: 'world'}
```

#### **Merge behavior:**
> - Overrides existing properties.

### `isStream`

**Type: `boolean`**\
**Default: `false`**

Whether the `got` function should return a [`Request` duplex stream](3-streams.md) or a [`Promise<Response>`](1-promise.md).

```js
import got from 'got';

// This:
const stream = got('https://httpbin.org/anything', {isStream: true});

// is semantically the same as this:
const stream = got.stream('https://httpbin.org/anything');

stream.setEncoding('utf8');
stream.on('data', console.log);
```

### `body`

**Type: `string | Buffer | stream.Readable | Generator | AsyncGenerator | FormData` or [`form-data` instance](https://github.com/form-data/form-data)**

The payload to send.

For `string` and `Buffer` types, the `content-length` header is automatically set if the `content-length` and `transfer-encoding` headers are missing.

**Since Got 12, the `content-length` header is not automatically set when `body` is an instance of [`fs.createReadStream()`](https://nodejs.org/api/fs.html#fs_fs_createreadstream_path_options).**

```js
import got from 'got';

const {data} = await got.post('https://httpbin.org/anything', {
	body: 'Hello, world!'
}).json();

console.log(data);
//=> 'Hello, world!'
```

Since Got 12, you can use spec-compliant [`FormData`](https://developer.mozilla.org/en-US/docs/Web/API/FormData) objects as request body, such as [`formdata-node`](https://github.com/octet-stream/form-data) or [`formdata-polyfill`](https://github.com/jimmywarting/FormData):

```js
import got from 'got';
import {FormData} from 'formdata-node'; // or:
// import {FormData} from 'formdata-polyfill/esm.min.js';

const form = new FormData();
form.set('greeting', 'Hello, world!');

const data = await got.post('https://httpbin.org/post', {
	body: form
}).json();

console.log(data.form.greeting);
//=> 'Hello, world!'
```

#### **Note:**
> - If `body` is specified, then the `json` or `form` option cannot be used.

#### **Note:**
> - If you use this option, `got.stream()` will be read-only.

#### **Note:**
> - Passing `body` with `GET` will throw unless the [`allowGetBody` option](#allowgetbody) is set to `true`.

#### **Note:**
> - This option is not enumerable and will not be merged with the instance defaults.

### `json`

**Type: JSON-serializable values**

JSON body. If set, the `content-type` header defaults to `application/json`.

```js
import got from 'got';

const {data} = await got.post('https://httpbin.org/anything', {
	json: {
		hello: 'world'
	}
}).json();

console.log(data);
//=> `{hello: 'world'}`
```

### `form`

**Type: <code>object&lt;string, [Primitive](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>**

The form body is converted to a query string using `(new URLSearchParams(form)).toString()`.

If set, the `content-type` header defaults to [`application/x-www-form-urlencoded`](https://url.spec.whatwg.org/#application/x-www-form-urlencoded).

```js
import got from 'got';

const {data} = await got.post('https://httpbin.org/anything', {
	form: {
		hello: 'world'
	}
}).json();

console.log(data);
//=> 'hello=world'
```

### `parseJson`

**Type: `(text: string) => unknown`**\
**Default: `(text: string) => JSON.parse(text)`**

The function used to parse JSON responses.

```js
import got from 'got';
import Bourne from '@hapi/bourne';

// Preventing prototype pollution by using Bourne
const parsed = await got('https://example.com', {
	parseJson: text => Bourne.parse(text)
}).json();

console.log(parsed);
```

### `stringifyJson`

**Type: `(object: unknown) => string`**\
**Default: `(object: unknown) => JSON.stringify(object)`**

The function used to stringify the body of JSON requests.

**Example: ignore all properties starting with an underscore**

```js
import got from 'got';

await got.post('https://example.com', {
	stringifyJson: object => JSON.stringify(object, (key, value) => {
		if (key.startsWith('_')) {
			return;
		}

		return value;
	}),
	json: {
		some: 'payload',
		_ignoreMe: 1234
	}
});
```

**Example: all numbers as strings**

```js
import got from 'got';

await got.post('https://example.com', {
	stringifyJson: object => JSON.stringify(object, (key, value) => {
		if (typeof value === 'number') {
			return value.toString();
		}

		return value;
	}),
	json: {
		some: 'payload',
		number: 1
	}
});
```

### `allowGetBody`

**Type: `boolean`**\
**Default: `false`**

Set this to `true` to allow sending body for the `GET` method.

However, the [HTTP/2 specification](https://datatracker.ietf.org/doc/html/rfc7540#section-8.1.3) says:

> An HTTP GET request includes request header fields and no payload body

Therefore this option has no effect when using HTTP/2.

#### **Note:**
> - This option is only meant to interact with non-compliant servers when you have no other choice.

#### **Note:**
> - The [RFC 7231](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore it's considered an [**anti-pattern**](https://en.wikipedia.org/wiki/Anti-pattern).

### `timeout`

**Type: `object`**

See the [Timeout API](6-timeout.md).

#### **Merge behavior:**
> - Overrides existing properties.

### `retry`

**Type: `object`**

See the [Retry API](7-retry.md).

#### **Merge behavior:**
> - Overrides existing properties.

### `hooks`

**Type: `object`**

See the [Hooks API](9-hooks.md).

#### **Merge behavior:**
> - Merges arrays via `[...hooksArray, ...next]`

### `encoding`

**Type: `string`**\
**Default: `'utf8'`**

[Encoding](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) to be used on [`setEncoding`](https://nodejs.org/api/stream.html#stream_readable_setencoding_encoding) of the response data.

To get a [`Buffer`](https://nodejs.org/api/buffer.html), you need to set `responseType` to `'buffer'` instead. Don't set this option to `null`.

```js
import got from 'got';

const response = await got('https://httpbin.org/anything', {
	encoding: 'base64'
}).text();

console.log(response);
//=> base64 string
```

#### **Note:**
> - This option does not affect streams! Instead, do:

```js
import got from 'got';

const stream = got.stream('https://httpbin.org/anything');

stream.setEncoding('base64');
stream.on('data', console.log);
```

### `responseType`

**Type: `'text' | 'json' | 'buffer'`**\
**Default: `'text'`**

The parsing method.

The promise also has `.text()`, `.json()` and `.buffer()` methods which return another Got promise for the parsed body.\
It's like setting the options to `{responseType: 'json', resolveBodyOnly: true}` but without affecting the main Got promise.

```js
import got from 'got';

const responsePromise = got('https://httpbin.org/anything');
const bufferPromise = responsePromise.buffer();
const jsonPromise = responsePromise.json();

const [response, buffer, json] = await Promise.all([responsePromise, bufferPromise, jsonPromise]);
// `response` is an instance of Got Response
// `buffer` is an instance of Buffer
// `json` is an object
```

#### **Note:**
> - When using streams, this option is ignored.

#### **Note:**
> - `'buffer'` will return the raw body buffer. Any modifications will also alter the result of `.text()` and `.json()`. Before overwriting the buffer, please copy it first via `Buffer.from(buffer)`.\
>  See https://github.com/nodejs/node/issues/27080

### `resolveBodyOnly`

**Type: `boolean`**\
**Default: `false`**

If `true`, the promise will return the [Response body](3-streams.md#response-1) instead of the [Response object](3-streams.md#response-1).

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

// This:
const body = await got(url).json();

// is semantically the same as this:
const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
```

### `context`

**Type: `object<string, unknown>`**\
**Default: `{}`**

**Note:**
> - Non-enumerable properties inside are **not** merged.

Contains user data. It's very useful for storing auth tokens:

```js
import got from 'got';

const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				if (typeof options.context.token !== 'string') {
					throw new Error('Token required');
				}

				options.headers.token = options.context.token;
			}
		]
	}
});

const context = {
	token: 'secret'
};

const {headers} = await instance('https://httpbin.org/headers', {context}).json();

console.log(headers);
//=> {token: 'secret', …}
```

This option is enumerable. In order to define non-enumerable properties inside, do the following:

```js
import got from 'got';

const context = {};

Object.defineProperties(context, {
	token: {
		value: 'secret',
		enumerable: false,
		configurable: true,
		writable: true
	}
});

const instance = got.extend({context});

console.log(instance.defaults.options.context);
//=> {}
```

#### **Merge behavior:**
> - Overrides existing properties.

### `cookieJar`

**Type: <code>object | [tough.cookieJar](https://github.com/salesforce/tough-cookie#cookiejar)</code>**

#### **Note:**
> - Setting this option will result in the `cookie` header being overwritten.

Cookie support. Handles parsing and storing automatically.

```js
import got from 'got';
import {CookieJar} from 'tough-cookie';

const cookieJar = new CookieJar();

await cookieJar.setCookie('foo=bar', 'https://example.com');
await got('https://example.com', {cookieJar});
```

#### `cookieJar.setCookie`

**Type: `(rawCookie: string, url: string) => void | Promise<void>`**

See [ToughCookie API](https://github.com/salesforce/tough-cookie#setcookiecookieorstring-currenturl-options-cberrcookie) for more information.

#### `cookieJar.getCookieString`

**Type: `(currentUrl: string) => string | Promise<string>`**

See [ToughCookie API](https://github.com/salesforce/tough-cookie#getcookiestring) for more information.

### `ignoreInvalidCookies`

**Type: `boolean`**\
**Default: `false`**

Ignore invalid cookies instead of throwing an error.\
Only useful when the `cookieJar` option has been set.

#### **Note:**
> - This is not recommended! Use at your own risk.

### `followRedirect`

**Type: `boolean`**\
**Default: `true`**

Defines if redirect responses should be followed automatically.

#### **Note:**
> - If a `303` is sent by the server in response to any request type (POST, DELETE, etc.), Got will request the resource pointed to in the location header via GET.\
>  This is in accordance with the [specification](https://tools.ietf.org/html/rfc7231#section-6.4.4). You can optionally turn on this behavior also for other redirect codes - see [`methodRewriting`](#methodrewriting).

```js
import got from 'got';

const instance = got.extend({followRedirect: false});

const response = await instance('http://google.com');

console.log(response.headers.location);
//=> 'https://google.com'
```

### `maxRedirects`

**Type: `number`**\
**Default: `10`**

If exceeded, the request will be aborted and a [`MaxRedirectsError`](8-errors.md#maxredirectserror) will be thrown.

```js
import got from 'got';

const instance = got.extend({maxRedirects: 3});

try {
	await instance('https://nghttp2.org/httpbin/absolute-redirect/5');
} catch (error) {
	//=> 'Redirected 3 times. Aborting.'
	console.log(error.message);
}
```

### `decompress`

**Type: `boolean`**\
**Default: `true`**

Decompress the response automatically. This will set the `accept-encoding` header to `gzip, deflate, br`.

If disabled, a compressed response is returned as a `Buffer`. This may be useful if you want to handle decompression yourself.

```js
import got from 'got';

const response = await got('https://google.com');

console.log(response.headers['content-encoding']);
//=> 'gzip'
```

### `dnsLookup`

**Type: `Function`**\
**Default: [`dns.lookup`](https://nodejs.org/api/dns.html#dns_dns_lookup_hostname_options_callback)**

Custom DNS resolution logic.

The function signature is the same as `dns.lookup`.

### `dnsCache`

**Type: <code>[CacheableLookup](https://github.com/szmarczak/cacheable-lookup) | false</code>**

An instance of `CacheableLookup` used for making DNS lookups.\
Useful when making lots of requests to different public hostnames.

**Note:**
> - This should stay disabled when making requests to internal hostnames such as localhost, database.local etc.
> - CacheableLookup uses `dns.resolver4(…)` and `dns.resolver6(…)` under the hood and falls back to `dns.lookup(…)` when the first two fail, which may lead to additional delay.

### `dnsLookupIpVersion`

**Type: `4 | 6`**\
**Default: `undefined`**

The IP version to use. Specifying `undefined` will use the default configuration.

### `request`

**Type: <code>Function<[ClientRequest](https://nodejs.org/api/http.html#http_class_http_clientrequest) | [IncomingMessage](https://nodejs.org/api/http.html#http_class_http_incomingmessage)> | AsyncFunction<[ClientRequest](https://nodejs.org/api/http.html#http_class_http_clientrequest) | [IncomingMessage](https://nodejs.org/api/http.html#http_class_http_incomingmessage)></code>**\
**Default: `http.request | https.request` *(depending on the protocol)***

Custom request function.

The main purpose of this is to [support HTTP/2 using a wrapper](https://github.com/szmarczak/http2-wrapper).

### `cache`

**Type: `object | false`**\
**Default: `false`**

[Cache adapter instance](cache.md) for storing cached response data.

### `cacheOptions`

**Type: `object`**\
**Default: `{}`**

[Cache options](https://github.com/kornelski/http-cache-semantics#constructor-options) used for the specified request.

### `http2`

**Type: `boolean`**\
**Default: `false`**

**Note:**
> - This option requires Node.js 15.10.0 or newer as HTTP/2 support on older Node.js versions is very buggy.

If `true`, the `request` option will default to `http2wrapper.auto` and the entire `agent` object will be passed.

**Note:**
> - ALPN negotiation will have place in order to determine if the server actually supports HTTP/2. If it doesn't, HTTP/1.1 will be used.

**Note:**
> - Setting the `request` option to `https.request` will disable HTTP/2 usage. It is required to use `http2wrapper.auto`.

**Note:**
> - There is no direct [`h2c`](https://datatracker.ietf.org/doc/html/rfc7540#section-3.1) support. However, you can provide a `h2session` option in a `beforeRequest` hook. See [an example](examples/h2c.js).

```js
import got from 'got';

const {headers} = await got(
	'https://httpbin.org/anything',
	{
		http2: true
	}
);

console.log(headers[':status']);
//=> 200
```

**Note:**
> - The current Got version may use an older version of [`http2-wrapper`](https://github.com/szmarczak/http2-wrapper).\
> If you prefer to use the newest one, set both `request` to `http2wrapper.auto` and `http2` to `true`.

```js
import http2wrapper from 'http2-wrapper';
import got from 'got';

const {headers} = await got(
	'https://httpbin.org/anything',
	{
		http2: true,
		request: http2wrapper.auto
	}
);

console.log(headers[':status']);
//=> 200
```

See the [`http2-wrapper` docs](https://github.com/szmarczak/http2-wrapper) to learn more about Agent and Proxy support.

### `agent`

**Type: `object`**\
**Default: `{}`**

An object with `http`, `https` and `http2` properties.

Got will automatically resolve the protocol and use the corresponding agent. It defaults to:

```js
{
	http: http.globalAgent,
	https: https.globalAgent,
	http2: http2.globalAgent
}
```

**Note:**
> The HTTP/2 `Agent` must be an instance of [`http2wrapper.Agent`](https://github.com/szmarczak/http2-wrapper#new-http2agentoptions)

### `throwHttpErrors`

**Type: `boolean`**\
**Default: `true`**

If `true`, it will [throw](8-errors.md#httperror) when the status code is not `2xx` / `3xx`.

If this is disabled, requests that encounter an error status code will be resolved with the response instead of throwing. This may be useful if you are checking for resource availability and are expecting error responses.

### `username`

**Type: `string`**\
**Default: `''`**

The `username` used for [Basic authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication).

### `password`

**Type: `string`**\
**Default: `''`**

The `password` used for [Basic authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication).

### `localAddress`

**Type: `string | undefined`**\
**Default: `undefined`**

The local IP address used to make the request.

### `createConnection`

**Type: `Function | undefined`**\
**Default: `undefined`**

The function used to retrieve a `net.Socket` instance when the `agent` option is not used.

### `https`

**Type: `object`**

See [Advanced HTTPS API](5-https.md).

### `pagination`

**Type: `object`**

See [Pagination API](4-pagination.md).

### `setHost`

**Type: `boolean`**\
**Default: `true`**

Specifies whether or not to automatically add the `Host` header.

### `maxHeaderSize`

**Type: `number | undefined`**\
**Default: `undefined`**

Optionally overrides the value of [`--max-http-header-size`](https://nodejs.org/api/cli.html#cli_max_http_header_size_size) (default 16KB: `16384`).

### `methodRewriting`

**Type: `boolean`**\
**Default: `false`**

Specifies if the HTTP request method should be [rewritten as `GET`](https://tools.ietf.org/html/rfc7231#section-6.4) on redirects.

As the [specification](https://tools.ietf.org/html/rfc7231#section-6.4) prefers to rewrite the HTTP method only on `303` responses, this is Got's default behavior. Setting `methodRewriting` to `true` will also rewrite `301` and `302` responses, as allowed by the spec. This is the behavior followed by `curl` and browsers.

**Note:**
> - Got never performs method rewriting on `307` and `308` responses, as this is [explicitly prohibited by the specification](https://www.rfc-editor.org/rfc/rfc7231#section-6.4.7).

### `enableUnixSockets`

**Type: `boolean`**\
**Default: `false`**

When enabled, requests can also be sent via [UNIX Domain Sockets](https://serverfault.com/questions/124517/what-is-the-difference-between-unix-sockets-and-tcp-ip-sockets).

> **Warning**
> Make sure you do your own URL sanitizing if you accept untrusted user input for the URL.

Use the following URL scheme: `PROTOCOL://unix:SOCKET:PATH`

- `PROTOCOL` - `http` or `https`
- `SOCKET` - Absolute path to a UNIX domain socket, for example: `/var/run/docker.sock`
- `PATH` - Request path, for example: `/v2/keys`

```js
import got from 'got';

await got('http://unix:/var/run/docker.sock:/containers/json', {enableUnixSockets: true});

// Or without protocol (HTTP by default)
await got('unix:/var/run/docker.sock:/containers/json', {enableUnixSockets: true});

// Enable Unix sockets for the whole instance.
const gotWithUnixSockets = got.extend({enableUnixSockets: true});

await gotWithUnixSockets('http://unix:/var/run/docker.sock:/containers/json');
```

## Methods

### `options.merge(other: Options | OptionsInit)`

Merges `other` into the current instance.

If you look at the [source code](../source/core/options.ts), you will notice that internally there is a `this._merging` property.\
Setters work a bit differently when it's `true`.

### `options.toJSON()`

Returns a new plain object that can be stored as [JSON](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#tojson_behavior).

### `options.createNativeRequestOptions()`

Creates a new object for native Node.js HTTP request options.

In other words, this translates Got options into Node.js options.

**Note:**
> - Some other stuff, such as timeouts, is handled internally by Got.

### `options.getRequestFunction()`

Returns a [`http.request`-like](https://nodejs.org/api/http.html#http_http_request_url_options_callback) function used to make the request.

### `options.freeze()`

Makes the entire `Options` instance read-only.
