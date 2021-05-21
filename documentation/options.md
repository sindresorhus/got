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

Type: <code>string | [URL](https://nodejs.org/api/url.html#url_the_whatwg_url_api)</code>\
Merge behavior: `replace`

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

Type: <code>string | [URLSearchParams](https://nodejs.org/api/url.html#url_class_urlsearchparams) | object&lt;string, [Primitive](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>\
Merge behavior: `override`

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

Type: `string`\
Merge behavior: `replace`\
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

Type: `string`\
Merge behavior: `replace`\
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

Type: `object<string, string>`\
Merge behavior: `override`\
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

Type: `boolean`\
Merge behavior: `replace`\
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

Type: `string | Buffer | stream.Readable` or [`form-data` instance](https://github.com/form-data/form-data)\
Merge behavior: `replace`

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

Type: JSON-serializable values\
Merge behavior: `replace`

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

Type: <code>object&lt;string, [Primitve](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)&gt;</code>\
Merge behavior: `replace`

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

Type: `(text: string) => unknown`\
Merge behavior: `replace`\
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

Type: `(object: unknown) => string`\
Merge behavior: `replace`\
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

### `timeout`

Type: `object`\
Merge behavior: `override`

See the [Timeout API](timeout.md).

### `retry`

Type: `object`\
Merge behavior: `override`

See the [Retry API](retry.md).

### `encoding`

Type: `string`\
Merge behavior: `replace`\
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

Type: `'text' | 'json' | 'buffer'`\
Merge behavior: `replace`\
Default: `'text'`

The parsing method.

The promise also has `.text()`, `.json()` and `.buffer()` methods which return another Got promise for the parsed body.\
It's like setting the options to `{responseType: 'json', resolveBodyOnly: true}` but without affecting the main Got promise.

```js
import got from 'got';

const responsePromise = got('https://httpbin.org/anything);
const bufferPromise = responsePromise.buffer();
const jsonPromise = responsePromise.json();

const [response, buffer, json] = await Promise.all([responsePromise, bufferPromise, jsonPromise]);
// `response` is an instance of Got Response
// `buffer` is an instance of Buffer
// `json` is an object
```

```js
import got from 'got';

const url = 'https://httpbin.org/anything';

// This:
const body = await got(url).json();

// is semantically the same as this:
const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
```

**Note:**
- When using streams, this option is ignored.

**Note:**
- `'buffer'` will return the raw body buffer. Any modifications will also alter the result of `.text()` and `.json()`. Before overwriting the buffer, please copy it first via `Buffer.from(buffer)`.\
  See https://github.com/nodejs/node/issues/27080
