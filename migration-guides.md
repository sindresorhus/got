# Migration guides

> :star: Switching from other HTTP request libraries to Got :star:

### Migrating from Request

You may think, it's too hard to switch. But that's not true. Let's take the very first example from `request` and see how it looks using `got`.

```js
const request = require('request');
request('https://google.com', (error, response, body) => {
  console.log('error:', error); // Print the error if one occurred
  console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
  console.log('body:', body); // Print the HTML for the Google homepage.
});

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

Now it looks cool, huh?

#### Options in common

Both `request` and `got` accept [`http.request` options](https://nodejs.org/api/http.html#http_http_request_options_callback).
These Got options are the same in with Request:

- [`url`](https://github.com/sindresorhus/got#url) (+ we accept [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) instances too!)
- [`body`](https://github.com/sindresorhus/got#body)
- [`json`](https://github.com/sindresorhus/got#json)
- [`followRedirect`](https://github.com/sindresorhus/got#followRedirect)
- [`encoding`](https://github.com/sindresorhus/got#encoding)

So if you're familiar with them, you're good to go :)

Oh, and one more thing... There's no `time` options. Assume it's always true.

#### Renamed options

Readability is very important to us, so we decided to rename these options:

- `qs` → [`query`](https://github.com/sindresorhus/got#query)
- `strictSSL` → [`rejectUnauthorized`](https://github.com/sindresorhus/got#rejectUnauthorized)
- `gzip` → [`decompress`](https://github.com/sindresorhus/got#decompress)
- `jar` → [`cookieJar`](https://github.com/sindresorhus/got#cookiejar) (accepts [`tough-cookie`](https://github.com/salesforce/tough-cookie) jar)

It is more clear, isn't it?

#### Changes in behavior

The [`timeout`](https://github.com/sindresorhus/got#timeout) option has some extra features. You can [set timeouts on particular events!](readme.md#timeout).

The [`query` option](https://github.com/sindresorhus/got#query) is always serialized using [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) unless it's a `string`.

The [`baseUrl` option](https://github.com/sindresorhus/got#baseurl) appends the ending slash if it's not present.

To use streams, just call `got.stream(url, options)` or `got(url, {stream: true, ...}`).

#### Breaking changes

- No `form` option. You have to pass a [`form-data` instance](https://github.com/form-data/form-data) through the [`body` option](https://github.com/sindresorhus/got#body).
- No `oauth`/`hawk`/`aws`/`httpSignature` option. To sign requests, you need to create a [custom instance](advanced-creation.md#signing-requests).
- No `agentClass`/`agentOptions`/`forever`/`pool` option.
- No proxy option. You need to [pass a custom agent](readme.md#proxies).
- No `removeRefererHeader`. But it doesn't mean it isn't possible! Of course it is, you need to use the [`beforeRequest` hook](https://github.com/sindresorhus/got#hooksbeforeRequest):

```js
const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				delete options.headers.referer;
			}
		]
	}
});

instance(url, options);
```

- no `jsonReviver`/`jsonReplacer` option (but you can you hooks for that too)

Hooks are powerful, aren't they? [Read more](readme.md#hooks) to know what else you can use the hooks for!

#### More about streams

Let's take a quick look on another example from `request`:

```js
http.createServer((req, res) => {
  if (req.url === '/doodle.png') {
    req.pipe(request('http://mysite.com/doodle.png')).pipe(res);
  }
});
```

The cool feature `request` has is that it can proxy headers. But Got is cool too. You can do excatly the same:

```js
http.createServer((req, res) => {
  if (req.url === '/doodle.png') {
    req.pipe(got.stream('http://mysite.com/doodle.png')).pipe(res);
  }
});
```

Nothing has really changed. But you need to remember to use `got.stream(url, options)` or `got(url, {stream: true, ...`}). That's it!

#### You're good to go!

Well, you have already come this far. Take a look at the [documentation](readme.md#highlights), it's really worth reading. There are [some great tips](readme.md#aborting-the-request). If something's unclear or doesn't work as it should, don't hestitate to open an issue.
