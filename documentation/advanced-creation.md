# Advanced creation

> Make calling REST APIs easier by creating niche-specific `got` instances.

#### got.create(settings)

Example: [gh-got](https://github.com/sindresorhus/gh-got/blob/master/index.js)

Configures a new `got` instance with the provided settings. You can access the resolved options with the `.defaults` property on the instance.

**Note:** In contrast to [`got.extend()`](../readme.md#gotextendinstances), this method has no defaults.

##### [options](readme.md#options)

To inherit from the parent, set it to `got.defaults.options` or use [`got.mergeOptions(defaults.options, options)`](../readme.md#gotmergeoptionsparentoptions-newoptions).<br>
**Note:** Avoid using [object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#Spread_in_object_literals) as it doesn't work recursively.

##### mutableDefaults

Type: `boolean`<br>
Default: `false`

States if the defaults are mutable. It can be useful when you need to [update headers over time](readme.md#hooksafterresponse), for example, update an access token when it expires.

##### handlers

Type: `Function[]`<br>
Default: `[]`

An array of functions. You execute them directly by calling `got()`. They are some sort of "global hooks" - these functions are called first. The last handler (*it's hidden*) is either [`asPromise`](../source/as-promise.ts) or [`asStream`](../source/as-stream.ts), depending on the `options.stream` property.

To inherit from the parent, set it as `got.defaults.handlers`.<br>
To use the default handler, just omit specifying this.

Each handler takes two arguments:

###### [options](readme.md#options)

**Note:** These options are [normalized](source/normalize-arguments.js).

###### next()

Returns a `Promise` or a `Stream` depending on [`options.stream`](readme.md#stream).

```js
const settings = {
	handlers: [
		(options, next) => {
			if (options.stream) {
				// It's a Stream, so we can perform stream-specific actions on it
				return next(options)
					.on('request', request => {
						setTimeout(() => {
							request.abort();
						}, 50);
					});
			}

			// It's a Promise
			return next(options);
		}
	],
	options: got.mergeOptions(got.defaults.options, {
		responseType: 'json'
	})
};

const jsonGot = got.create(settings);
```

Sometimes you don't need to use `got.create(defaults)`. You should go for `got.extend(options)` if you don't want to overwrite the defaults:

```js
const settings = {
	handler: got.defaults.handler,
	options: got.mergeOptions(got.defaults.options, {
		headers: {
			unicorn: 'rainbow'
		}
	})
};

const unicorn = got.create(settings);

// Same as:
const unicorn = got.extend({headers: {unicorn: 'rainbow'}});
```

**Note:** Handlers can be asynchronous. The recommended approach is:

```js
const handler = (options, next) => {
	if (options.stream) {
		// It's a Stream
		return next(options);
	}

	// It's a Promise
	return (async () => {
		try {
			const response = await next(options);

			response.yourOwnProperty = true;

			return response;
		} catch (error) {
			// Every error will be replaced by this one.
			// Before you receive any error here,
			// it will be passed to the `beforeError` hooks first.

			// Note: this one won't be passed to `beforeError` hook. It's final.
			throw new Error('Your very own error.');
		}
	})();
};
```

### Merging instances

Got supports composing multiple instances together. This is very powerful. You can create a client that limits download speed and then compose it with an instance that signs a request. It's like plugins without any of the plugin mess. You just create instances and then compose them together.

To mix them use `instanceA.extend(instanceB, instanceC, ...)`, that's all.

## Examples

Some examples of what kind of instances you could compose together:

#### Denying redirects that lead to other sites than specified

```js
const controlRedirects = got.extend({
	handlers: [
		(options, next) => {
			const promiseOrStream = next(options);
			return promiseOrStream.on('redirect', response => {
				const host = new URL(resp.url).host;
				if (options.allowedHosts && !options.allowedHosts.includes(host)) {
					promiseOrStream.cancel(`Redirection to ${host} is not allowed`);
				}
			});
		}
	]
});
```

#### Limiting download & upload size

It can be useful when your machine has limited amount of memory.

```js
const limitDownloadUpload = got.extend({
	handlers: [
		(options, next) => {
			let promiseOrStream = next(options);
			if (typeof options.downloadLimit === 'number') {
				promiseOrStream.on('downloadProgress', progress => {
					if (progress.transferred > options.downloadLimit && progress.percent !== 1) {
						promiseOrStream.cancel(`Exceeded the download limit of ${options.downloadLimit} bytes`);
					}
				});
			}

			if (typeof options.uploadLimit === 'number') {
				promiseOrStream.on('uploadProgress', progress => {
					if (progress.transferred > options.uploadLimit && progress.percent !== 1) {
						promiseOrStream.cancel(`Exceeded the upload limit of ${options.uploadLimit} bytes`);
					}
				});
			}

			return promiseOrStream;
		}
	]
});
```

#### No user agent

```js
const noUserAgent = got.extend({
	headers: {
		'user-agent': null
	}
});
```

#### Custom endpoint

```js
const httpbin = got.extend({
	prefixUrl: 'https://httpbin.org/'
});
```

#### Signing requests

```js
const crypto = require('crypto');

const getMessageSignature = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('hex').toUpperCase();
const signRequest = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				options.headers['sign'] = getMessageSignature(options.body || '', process.env.SECRET);
			}
		]
	}
});
```

#### Putting it all together

If these instances are different modules and you don't want to rewrite them, use `got.extend(...instances)`.

**Note**: The `noUserAgent` instance must be placed at the end of chain as the instances are merged in order. Other instances do have the `user-agent` header.

```js
const merged = got.extend(controlRedirects, limitDownloadUpload, httpbin, signRequest, noUserAgent);

(async () => {
	// There's no 'user-agent' header :)
	await merged('/');
	/* HTTP Request =>
	 * GET / HTTP/1.1
	 * accept-encoding: gzip, deflate, br
	 * sign: F9E66E179B6747AE54108F82F8ADE8B3C25D76FD30AFDE6C395822C530196169
	 * Host: httpbin.org
	 * Connection: close
	 */

	const MEGABYTE = 1048576;
	await merged('http://ipv4.download.thinkbroadband.com/5MB.zip', {downloadLimit: MEGABYTE, prefixUrl: ''});
	// CancelError: Exceeded the download limit of 1048576 bytes

	await merged('https://jigsaw.w3.org/HTTP/300/301.html', {allowedHosts: ['google.com'], prefixUrl: ''});
	// CancelError: Redirection to jigsaw.w3.org is not allowed
})();
```
