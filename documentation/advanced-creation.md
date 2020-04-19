# Advanced creation

> Make calling REST APIs easier by creating niche-specific `got` instances.

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
		'user-agent': undefined
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
	await merged('https://ipv4.download.thinkbroadband.com/5MB.zip', {downloadLimit: MEGABYTE, prefixUrl: ''});
	// CancelError: Exceeded the download limit of 1048576 bytes

	await merged('https://jigsaw.w3.org/HTTP/300/301.html', {allowedHosts: ['google.com'], prefixUrl: ''});
	// CancelError: Redirection to jigsaw.w3.org is not allowed
})();
```
