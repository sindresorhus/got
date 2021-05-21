[> Back to homepage](../readme.md#documentation)

## Options

Source code: [`source/core/options.ts`](../source/core/options.ts)

Like `fetch` contains the options in a `Request` instance, Got does so in `Options`.\
It is made of getters and setters that provide fast option normalization and validation.

#### Merge behavior explained

When an option is already set, there are a few possible scenarios that can happen:

- `replace` - fully replaces the value,
- `override` - used when merging objects; overrides existing keys.

### `url`

Merge behavior: `replace`\
Type: <code>string | [URL](https://nodejs.org/api/url.html#url_the_whatwg_url_api)</code>

The URL to request. Usually the `url` represents a [WHATWG URL](https://url.spec.whatwg.org/#url-class).

```js
import got from 'got';

// This:
await got('https://httpbin.org/anything');

// is semantically the same as this:
await got(new URL('https://httpbin.org/anything'));
```

**Note:**
- Throws if no protocol specified.

**Note:**
- If `url` is a string, then the `query` string will **not** be parsed as search params.\
  This is in accordance to [the specification](https://datatracker.ietf.org/doc/html/rfc7230#section-2.7).\
  If you want to pass search params instead, use the `searchParams` option below.

### `searchParams`

Merge behavior: `override`\
Type: <code>string | [URLSearchParams](https://nodejs.org/api/url.html#url_class_urlsearchparams) | object&lt;string, [Primitive](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>

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

**Note:**
- This will override the `query` string in `url`.

**Note:**
- Leading slashes are disallowed to enforce consistency and avoid confusion.\
  For example, when the prefix URL is `https://example.com/foo` and the input is `/bar`, there's ambiguity whether the resulting URL would become `https://example.com/foo/bar` or `https://example.com/bar`. The latter is used by browsers.

### `prefixUrl`

Merge behavior: `replace`\
Type: `string`\
Default: `''`

The string to be prepended to `url`. Usually this is an [absolute URL](https://url.spec.whatwg.org/#absolute-url-string).

```js
import got from 'got';

// This:
const instance = got.extend({prefixUrl: 'https://httpbin.org'});
await instance('anything');

// is semantically the same as this:
await got('https://httpbin.org/anything');
```

**Note:**
- `prefixUrl` is ignored when `url` is an instance of [`URL`](https://nodejs.org/api/url.html#url_the_whatwg_url_api).

**Note:**
- Changing `prefixUrl` also updates the `url` option if set.

**Note:**
- If you're passing an absolute URL as string `url`, you need to set `prefixUrl` to an empty string.

### `method`

Merge behavior: `replace`\
Type: `string`\
Default: `GET`

The [HTTP method](https://datatracker.ietf.org/doc/html/rfc7231#section-4) used to make the request.\
The most common methods are: `GET`, `HEAD`, `POST`, `PUT`, `DELETE`.

```js
import got from 'got';

const {method} = await got.post('https://httpbin.org/anything').json();

console.log(method);
// => 'POST'
```

### `headers`

Merge behavior: `override`\
Type: `object<string, string>`\
Default: `{}`

The [HTTP headers](https://datatracker.ietf.org/doc/html/rfc7231#section-8.3) to be sent.

```js
import got from 'got';

const {headers} = await got.post('https://httpbin.org/anything', {
	hello: 'world'
}).json();

console.log(method);
// => {hello: 'world'}
```

### `isStream`

Merge behavior: `replace`\
Type: `boolean`\
Default: `false`

Whether the request should return a [`Request` duplex stream](streams.md) or a [`Promise<Response>`](promise.md).

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

Merge behavior: `replace`\
Type: `string | Buffer | stream.Readable` or [`form-data` instance](https://github.com/form-data/form-data)

The payload to send.

The `content-length` header is automatically set if the `content-length` and `transfer-encoding` headers are missing.

**Since Got 12, the `content-length` header is not automatically set when `body` is an instance of [`fs.createReadStream()`](https://nodejs.org/api/fs.html#fs_fs_createreadstream_path_options).**

```js
import got from 'got';

const {data} = await got.post('https://httpbin.org/anything', {
	body: 'Hello, world!'
}).json();

console.log(data);
//=> 'Hello, world!'
```

**Note:**
- If `body` is specified, then the `json` or `form` option cannot be used.

**Note:**
- If you use this option, `got.stream()` will be read-only.

**Note:**
- Passing `body` with `GET` will throw unless the [`allowGetBody` option](#allowGetBody) is set to `true`.

### `json`

Merge behavior: `replace`\
Type: JSON-serializable values

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

Merge behavior: `replace`\
Type: <code>object&lt;string, [Primitve](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>

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

Merge behavior: `replace`\
Type: `(text: string) => unknown`\
Default: `(text: string) => JSON.parse(text)`

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

Merge behavior: `replace`\
Type: `(object: unknown) => string`
Default: `(object: unknown) => JSON.stringify(object)`

The function used to stringify the body of JSON requests.

**Example: ignore properties starting with `_`**

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

Merge behavior: `replace`\
Type: `boolean`\
Default: `false`

Set this to `true` to allow sending body for the `GET` method.

However, the [HTTP/2 specification](https://datatracker.ietf.org/doc/html/rfc7540#section-8.1.3) says:

> An HTTP GET request includes request header fields and no payload body

Therefore this option has no effect when using HTTP/2.

**Note:**
- This option is only meant to interact with non-compliant servers when you have no other choice.

**Note:**
- The [RFC 7321](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore it's considered an [**anti-pattern**](https://en.wikipedia.org/wiki/Anti-pattern).

### `timeout`

Merge behavior: `override`\
Type: `object`

See the [Timeout API](timeout.md).

### `retry`

Merge behavior: `override`\
Type: `object`

See the [Retry API](retry.md).

### `encoding`

Merge behavior: `replace`\
Type: `string`\
Default: `utf8`

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

**Note:**
- This option does not affect streams! Instead, do:

```js
import got from 'got';

const stream = got.stream('https://httpbin.org/anything');

stream.setEncoding('base64');
stream.on('data', console.log);
```

### `responseType`

Merge behavior: `replace`\
Type: `'text' | 'json' | 'buffer'`\
Default: `'text'`

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

**Note:**
- When using streams, this option is ignored.

**Note:**
- `'buffer'` will return the raw body buffer. Any modifications will also alter the result of `.text()` and `.json()`. Before overwriting the buffer, please copy it first via `Buffer.from(buffer)`.\
  See https://github.com/nodejs/node/issues/27080

### `resolveBodyOnly`

Merge behavior: `replace`\
Type: `boolean`\
Default: `false`

If `true`, the promise will return the [Response body](#) instead of the [Response object](#).

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

// This:
const body = await got(url).json();

// is semantically the same as this:
const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
```

### `context`

Merge behavior: `override`\
Type: `object<string, unknown>`\
Default: `{}`

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

This option is enumerable. In order to define non-enumerable properties, do the following:

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

### `cookieJar`

Merge behavior: `replace`\
Type: <code>object | [tough.cookieJar](https://github.com/salesforce/tough-cookie#cookiejar)</code>

**Note:**
- Setting this option will result in the `cookie` header being overwritten.

Cookie support. Handles parsing and storing automatically.

```js
import {promisify} from 'util';
import got from 'got';
import {CookieJar} from 'tough-cookie';

const cookieJar = new CookieJar();
const setCookie = promisify(cookieJar.setCookie.bind(cookieJar));

await setCookie('foo=bar', 'https://example.com');
await got('https://example.com', {cookieJar});
```

#### `cookieJar.setCookie`

Type: `(rawCookie: string, url: string) => void | Promise<void>`

See [ToughCookie API](https://github.com/salesforce/tough-cookie#setcookiecookieorstring-currenturl-options-cberrcookie) for more information.

#### `cookieJar.getCookieString`

Type: `(currentUrl: string) => string | Promise<string>`

See [ToughCookie API](https://github.com/salesforce/tough-cookie#getcookiestring) for more information.

### `ignoreInvalidCookies`

Merge behavior: `replace`\
Type: `boolean`\
Default: `false`

Ignore invalid cookies instead of throwing an error.\
Only useful when the cookieJar option has been set.

**Note:**
- This is not recommended! Use at your own risk.

### `followRedirect`

Merge behavior: `replace`\
Type: `boolean`\
Default: `true`

Defines if redirect responses should be followed automatically.

**Note:**
- If a `303` is sent by the server in response to any request type (POST, DELETE, etc.), Got will automatically request the resource pointed to in the location header via GET.\
  This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

```js
import got from 'got';

const instance = got.extend({followRedirect: false});

const response = await instance('http://google.com');

console.log(response.headers.location);
//=> 'https://google.com'
```

### `maxRedirects`

Merge behavior: `replace`\
Type: `number`\
Default: `10`

If exceeded, the request will be aborted and a `MaxRedirectsError` will be thrown.

```js
import got from 'got';

const instance = got.extend({maxRedirect: 3});
```

### `decompress`

Merge behavior: `replace`\
Type: `boolean`\
Default: `true`

Decompress the response automatically.

```js
import got from 'got';

const response = await got('https://google.com');

console.log(response.headers['content-encoding']);
```
