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

// is the same as:
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

// is the same as this:
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

// is the same as this:
const stream = got.stream('https://httpbin.org/anything');
```

### body

Type: `string | Buffer | stream.Readable` or [`form-data` instance](https://github.com/form-data/form-data)\
Merge behavior: `replace`

The payload to send.

The `content-length` header is automatically set if the `content-length` and `transfer-encoding` headers are missing.

**Since Got 12, the `content-length` header is not automatically set when `body` is an instance of [`fs.createReadStream()`](https://nodejs.org/api/fs.html#fs_fs_createreadstream_path_options).**

**Note:**
- If `body` is specified, then the `json` or `form` option cannot be used.

**Note:**
- If you use this option, `got.stream()` will be read-only.

**Note:**
- Passing `body` with `GET` will throw unless the [`allowGetBody` option](#allowGetBody) is set to `true`.
