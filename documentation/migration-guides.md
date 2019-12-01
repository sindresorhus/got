# Migration guides

> :star: Switching from other HTTP request libraries to Got :star:

### Migrating from Request

You may think it's too hard to switch, but it's really not. 🦄

Let's take the very first example from Request's readme:

```js
const request = require('request');

request('https://google.com', (error, response, body) => {
	console.log('error:', error);
	console.log('statusCode:', response && response.statusCode);
	console.log('body:', body);
});
```

With Got, it is:

```js
const got = require('got');

(async () => {
	try {
		const response = await got('https://google.com');
		console.log('statusCode:', response.statusCode);
		console.log('body:', response.body);
	} catch (error) {
		console.log('error:', error);
	}
})();
```

Looks better now, huh? 😎

#### Common options

Both Request and Got accept [`http.request` options](https://nodejs.org/api/http.html#http_http_request_options_callback).

These Got options are the same as with Request:

- [`url`](https://github.com/sindresorhus/got#url) (+ we accept [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) instances too!)
- [`body`](https://github.com/sindresorhus/got#body)
- [`followRedirect`](https://github.com/sindresorhus/got#followRedirect)
- [`encoding`](https://github.com/sindresorhus/got#encoding)
- [`maxRedirects`](https://github.com/sindresorhus/got#maxredirects)

So if you're familiar with them, you're good to go.

Oh, and one more thing... There's no `time` option. Assume [it's always true](https://github.com/sindresorhus/got#timings).

#### Renamed options

Readability is very important to us, so we have different names for these options:

- `qs` → [`searchParams`](https://github.com/sindresorhus/got#searchParams)
- `strictSSL` → [`rejectUnauthorized`](https://github.com/sindresorhus/got#rejectUnauthorized)
- `gzip` → [`decompress`](https://github.com/sindresorhus/got#decompress)
- `jar` → [`cookieJar`](https://github.com/sindresorhus/got#cookiejar) (accepts [`tough-cookie`](https://github.com/salesforce/tough-cookie) jar)

It's more clear, isn't it?

#### Changes in behavior

The [`timeout` option](https://github.com/sindresorhus/got#timeout) has some extra features. You can [set timeouts on particular events](readme.md#timeout)!

The [`searchParams` option](https://github.com/sindresorhus/got#searchParams) is always serialized using [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) unless it's a `string`.

To use streams, just call `got.stream(url, options)` or `got(url, {isStream: true, ...}`).

#### Breaking changes

- The `json` option is not a `boolean`, it's an `Object`. It will be stringified and used as a body.
- The `form` option is an `Object`. It can be a plain object or a [`form-data` instance](https://github.com/sindresorhus/got/#form-data).
- No `oauth`/`hawk`/`aws`/`httpSignature` option. To sign requests, you need to create a [custom instance](advanced-creation.md#signing-requests).
- No `agentClass`/`agentOptions`/`pool` option.
- No `forever` option. You need to use [forever-agent](https://github.com/request/forever-agent).
- No `proxy` option. You need to [pass a custom agent](readme.md#proxies).
- No `baseUrl` option. Instead, there is `prefixUrl` which appends a trailing slash if not present. It will be always prepended unless `url` is an instance of URL.
- No `removeRefererHeader` option. You can remove the referer header in a [`beforeRequest` hook](https://github.com/sindresorhus/got#hooksbeforeRequest):

```js
const gotInstance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				delete options.headers.referer;
			}
		]
	}
});

gotInstance(url, options);
```

- No `jsonReviver`/`jsonReplacer` option, but you can use hooks for that too:

```js
const gotInstance = got.extend({
	hooks: {
		init: [
			options => {
				if (options.jsonReplacer && options.json) {
					options.body = JSON.stringify(options.json, options.jsonReplacer);
					delete options.json;
				}
			}
		],
		afterResponse: [
			response => {
				const {options} = response.request;
				if (options.jsonReviver && options.responseType === 'json') {
					options.responseType = 'default';
					response.body = JSON.parse(response.body, options.jsonReviver);
				}

				return response;
			}
		]
	}
});

gotInstance(url, options);
```

Hooks are powerful, aren't they? [Read more](readme.md#hooks) to see what else you achieve using hooks.

#### More about streams

Let's take a quick look at another example from Request's readme:

```js
http.createServer((request, response) => {
	if (request.url === '/doodle.png') {
		request.pipe(request('https://example.com/doodle.png')).pipe(response);
	}
});
```

The cool feature here is that Request can proxy headers with the stream, but Got can do that too:

```js
const stream = require('stream');
const {promisify} = require('util');
const got = require('got');

const pipeline = promisify(stream.pipeline);

http.createServer(async (request, response) => {
	if (request.url === '/doodle.png') {
		// When someone makes a request to our server, we receive a body and some headers.
		// These are passed to Got. Got proxies downloaded data to our server response,
		// so you don't have to do `response.writeHead(statusCode, headers)` and `response.end(body)`.
		// It's done automatically.
		await pipeline(
			got.stream('https://example.com/doodle.png'),
			response
		);
	}
});
```

Nothing has really changed. Just remember to use `got.stream(url, options)` or `got(url, {isStream: true, …})`. That's it!

#### You're good to go!

Well, you have already come this far :tada: Take a look at the [documentation](readme.md#highlights). It's worth the time to read it. There are [some great tips](readme.md#aborting-the-request). If something is unclear or doesn't work as it should, don't hesitate to open an issue.
