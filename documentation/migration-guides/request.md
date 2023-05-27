[> Back to homepage](../../readme.md#documentation)

## Migration guides

> You may think it's too hard to switch, but it's really not. 🦄

### Request

Let's take the very first example from [Request's readme](https://github.com/request/request#super-simple-to-use):

```js
import request from 'request';

request('https://google.com', (error, response, body) => {
	console.log('error:', error);
	console.log('statusCode:', response && response.statusCode);
	console.log('body:', body);
});
```

With Got, it is:

```js
import got from 'got';

try {
	const response = await got('https://google.com');
	console.log('statusCode:', response.statusCode);
	console.log('body:', response.body);
} catch (error) {
	console.log('error:', error);
}
```

Looks better now, huh? 😎

#### Common options

These Got options are the same as with Request:

- [`url`](../2-options.md#url)
- [`body`](../2-options.md#body)
- [`followRedirect`](../2-options.md#followredirect)
- [`encoding`](../2-options.md#encoding)
- [`maxRedirects`](../2-options.md#maxredirects)
- [`localAddress`](../2-options.md#localaddress)
- [`headers`](../2-options.md#headers)
- [`createConnection`](../2-options.md#createconnection)
- [UNIX sockets](../2-options.md#enableunixsockets): `http://unix:SOCKET:PATH`

The `time` option does not exist, assume [it's always true](../6-timeout.md).

So if you're familiar with these, you're good to go.

#### Renamed options

**Note:**
> - Got stores HTTPS options inside [`httpsOptions`](../2-options.md#httpsoptions). Some of them have been renamed. [Read more](../5-https.md).

Readability is very important to us, so we have different names for these options:

- `qs` → [`searchParams`](../2-options.md#serachparams)
- `strictSSL` → [`rejectUnauthorized`](../2-options.md#rejectunauthorized)
- `gzip` → [`decompress`](../2-options.md#decompress)
- `jar` → [`cookieJar`](../2-options.md#cookiejar) (accepts [`tough-cookie`](https://github.com/salesforce/tough-cookie) jar)
- `jsonReviver` → [`parseJson`](../2-options.md#parsejson)
- `jsonReplacer` → [`stringifyJson`](../2-options.md#stringifyjson)

#### Changes in behavior

- The [`agent` option](../2-options.md#agent) is now an object with `http`, `https` and `http2` properties.
- The [`timeout` option](../6-timeout.md) is now an object. You can set timeouts on particular events!
- The [`searchParams` option](https://github.com/sindresorhus/got#searchParams) is always serialized using [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams).
- In order to pass a custom query string, provide it with the `url` option.\
  `got('https://example.com', {searchParams: {test: ''}})` → `https://example.com/?test=`\
  `got('https://example.com/?test')` → `https://example.com/?test`
- To use streams, call `got.stream(url, options)` or `got(url, {…, isStream: true})`.

#### Breaking changes

- The `json` option is not a `boolean`, it's an `object`. It will be stringified and used as a body.
- The `form` option is an `object` and will be used as `application/x-www-form-urlencoded` body.
- All headers are converted to lowercase.\
  According to [the spec](https://datatracker.ietf.org/doc/html/rfc7230#section-3.2), the headers are case-insensitive.
- No `oauth` / `hawk` / `aws` / `httpSignature` option.\
  To sign requests, you need to create a [custom instance](../examples/advanced-creation.js).
- No `agentClass` / `agentOptions` / `pool` option.
- No `forever` option.\
  You need to pass an agent with `keepAlive` option set to `true`.
- No `proxy` option. You need to [pass a custom agent](../tips.md#proxy).
- No `auth` option.\
  You need to use [`username`](../2-options.md#username) / [`password`](../2-options.md#password) instead or set the `authorization` header manually.
- No `baseUrl` option.\
  Instead, there is [`prefixUrl`](../2-options.md#prefixurl) which appends a trailing slash if not present.
- No `removeRefererHeader` option.\
  You can remove the `referer` header in a [`beforeRequest` hook](../9-hooks.md#beforerequest).
- No `followAllRedirects` option.

Hooks are very powerful. [Read more](../9-hooks.md) to see what else you achieve using hooks.

#### More about streams

Let's take a quick look at another example from Request's readme:

```js
http.createServer((serverRequest, serverResponse) => {
	if (serverRequest.url === '/doodle.png') {
		serverRequest.pipe(request('https://example.com/doodle.png')).pipe(serverResponse);
	}
});
```

The cool feature here is that Request can proxy headers with the stream, but Got can do that too!

```js
import {pipeline as streamPipeline} from 'node:stream/promises';
import got from 'got';

const server = http.createServer(async (serverRequest, serverResponse) => {
	if (serverRequest.url === '/doodle.png') {
		await streamPipeline(
			got.stream('https://example.com/doodle.png'),
			serverResponse
		);
	}
});

server.listen(8080);
```

In terms of streams nothing has really changed.

#### Convenience methods

- If you were using `request.get`, `request.post`, and so on - you can do the same with Got.
- The `request.defaults({…})` method has been renamed. You can do the same with `got.extend({…})`.
- There is no `request.cookie()` nor `request.jar()`. You have to use `tough-cookie` directly.

#### You're good to go!

Well, you have already come this far :tada:\
Take a look at the [documentation](../../readme.md#documentation). It's worth the time to read it.\
There are [some great tips](../tips.md).

If something is unclear or doesn't work as it should, don't hesitate to [open an issue](https://github.com/sindresorhus/got/issues/new/choose).
