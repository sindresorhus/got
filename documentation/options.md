[> Back to home](../readme.md#documentation)

## Options

Like `fetch` contains the options in a `Request` instance, Got does so in `Options`.\
It is made of getters and setters that provide fast option normalization and validation.

### `url`

Type: <code>string | [URL](https://nodejs.org/api/url.html#url_the_whatwg_url_api)</code>

The URL to request.

```js
import got from 'got';

// This:
await got('https://example.com');

// is the same as:
await got(new URL('https://example.com'));
```

**Note:**
- Throws if no protocol specified.

**Note:**
- If `url` is a string, then the `query` string will **not** be parsed as search params.\
  This is in accordance to [the specification](https://datatracker.ietf.org/doc/html/rfc7230#section-2.7).\
  If you want to pass search params instead, use the `searchParams` option below.

### `searchParams`

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

await got('https://example.com', {searchParams});

console.log(searchParams.toString());
//=> 'key=a&key=b'
```

**Note:**
- This will override the `query` string in `url`.

### `method`

Type: `string`\
Default: `GET`

The [HTTP method](https://datatracker.ietf.org/doc/html/rfc7231#section-4) used to make the request. The most common methods are: `GET`, `HEAD`, `POST`, `PUT`, `DELETE`.
