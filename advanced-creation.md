# Advanced creation

> Make calling REST APIs easier by creating niche-specific `got` instances.

#### got.create(settings)

Example: [gh-got](https://github.com/sindresorhus/gh-got/blob/master/index.js)

Configure a new `got` instance with the provided settings.<br>
**Note:** In contrast to `got.extend()`, this method has no defaults.

##### [options](readme.md#options)

To inherit from parent, set it as `got.defaults.options` or use [`got.mergeOptions(defaults.options, options)`](readme.md#gotmergeoptionsparentoptions-newoptions).<br>
**Note**: Avoid using [object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#Spread_in_object_literals) as it doesn't work recursively.

##### handler

Type: `Function`<br>
Default: `undefined`

A function making additional changes to the request.

To inherit from parent, set it as `got.defaults.handler`.<br>
To use the default handler, just omit specifying this.

###### [options](readme.md#options)

**Note:** These options are [normalized](source/normalize-arguments.js).

###### next()

Returns a `Promise` or a `Stream` depending on [`options.stream`](readme.md#stream).

```js
const settings = {
	handler: (options, next) => {
		if (options.stream) {
			// It's a Stream
			// We can perform stream-specific actions on it
			return next(options)
				.on('request', request => setTimeout(() => request.abort(), 50));
		}

		// It's a Promise
		return next(options);
	},
	options: got.mergeOptions(got.defaults.options, {
		json: true
	})
};

const jsonGot = got.create(settings);
```

```js
const defaults = {
	options: {
		retry: {
			retries: 2,
			methods: [
				'GET',
				'PUT',
				'HEAD',
				'DELETE',
				'OPTIONS',
				'TRACE'
			],
			statusCodes: [
				408,
				413,
				429,
				500,
				502,
				503,
				504
			]
		},
		cache: false,
		decompress: true,
		useElectronNet: false,
		throwHttpErrors: true,
		headers: {
			'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
		},
		hooks: {
			beforeRequest: []
		}
	}
};

// Same as:
const defaults = {
	handler: got.defaults.handler,
	options: got.defaults.options
};

const unchangedGot = got.create(defaults);
```

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

### Merging instances

Got supports composing multiple instances together. This is very powerful. You can create a client that limits download speed and then compose it with an instance that signs a request. It's like plugins without any of the plugin mess. You just create instances and then compose them together.

#### got.mergeInstances(instanceA, instanceB, ...)

Merges many instances into a single one:
- options are merged using [`got.mergeOptions()`](readme.md#gotmergeoptionsparentoptions-newoptions) (+ hooks are merged too),
- handlers are stored in an array.

## Examples

Some examples of what kind of instances you could compose together:

#### Denying redirects that lead to other sites than specified

```js
const controlRedirects = got.create({
	options: got.defaults.options,
	handler: (options, next) => {
		const promiseOrStream = next(options);
		return promiseOrStream.on('redirect', resp => {
			const host = new URL(resp.url).host;
			if (options.allowedHosts && !options.allowedHosts.includes(host)) {
				promiseOrStream.cancel(`Redirection to ${host} is not allowed`);
			}
		});
	}
});
```

#### Limiting download & upload

It's very useful in case your machine's got a little amount of RAM.

```js
const limitDownloadUpload = got.create({
    options: got.defaults.options,
    handler: (options, next) => {
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
	baseUrl: 'https://httpbin.org/'
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

If these instances are different modules and you don't want to rewrite them, use `got.mergeInstances()`.

**Note**: The `noUserAgent` instance must be placed at the end of chain as the instances are merged in order. Other instances do have the `user-agent` header.

```js
const merged = got.mergeInstances(controlRedirects, limitDownloadUpload, httpbin, signRequest, noUserAgent);

(async () => {
	// There's no 'user-agent' header :)
	await merged('/');
	/* HTTP Request =>
	 * GET / HTTP/1.1
	 * accept-encoding: gzip, deflate
	 * sign: F9E66E179B6747AE54108F82F8ADE8B3C25D76FD30AFDE6C395822C530196169
	 * Host: httpbin.org
	 * Connection: close
	 */

	const MEGABYTE = 1048576;
	await merged('http://ipv4.download.thinkbroadband.com/5MB.zip', {downloadLimit: MEGABYTE});
	// CancelError: Exceeded the download limit of 1048576 bytes

	await merged('https://jigsaw.w3.org/HTTP/300/301.html', {allowedHosts: ['google.com']});
	// CancelError: Redirection to jigsaw.w3.org is not allowed
})();
```
