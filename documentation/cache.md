[> Back to homepage](../readme.md#documentation)

## Cache

Got implements [RFC 7234](https://httpwg.org/specs/rfc7234.html) compliant HTTP caching which works out of the box in-memory and is easily pluggable with a wide range of storage adapters. Fresh cache entries are served directly from the cache, and stale cache entries are revalidated with `If-None-Match` / `If-Modified-Since` headers. You can read more about the underlying cache behavior in the [`cacheable-request` documentation](https://github.com/lukechilds/cacheable-request).

You can use the JavaScript `Map` type as an in-memory cache:

```js
import got from 'got';

const map = new Map();

let response = await got('https://sindresorhus.com', {cache: map});
console.log(response.isFromCache);
//=> false

response = await got('https://sindresorhus.com', {cache: map});
console.log(response.isFromCache);
//=> true
```

Got uses [Keyv](https://github.com/lukechilds/keyv) internally to support a wide range of storage adapters. For something more scalable you could use an [official Keyv storage adapter](https://github.com/lukechilds/keyv#official-storage-adapters):

```
$ npm install @keyv/redis
```

```js
import got from 'got';
import KeyvRedis from '@keyv/redis';

const redis = new KeyvRedis('redis://user:pass@localhost:6379');

await got('https://sindresorhus.com', {cache: redis});
```

Got supports anything that follows the Map API, so it's easy to write your own storage adapter or use a third-party solution.

For example, the following are all valid storage adapters:

```js
const storageAdapter = new Map();

await got('https://sindresorhus.com', {cache: storageAdapter});
```

```js
import storageAdapter from './my-storage-adapter';

await got('https://sindresorhus.com', {cache: storageAdapter});
```

```js
import QuickLRU from 'quick-lru';

const storageAdapter = new QuickLRU({maxSize: 1000});

await got('https://sindresorhus.com', {cache: storageAdapter});
```

View the [Keyv docs](https://github.com/lukechilds/keyv) for more information on how to use storage adapters.

### Advanced caching mechanisms

The `request` function may return an instance of `IncomingMessage`-like class.

```js
import https from 'https';
import {Readable} from 'stream';
import got from 'got';

const getCachedResponse = (url, options) => {
	const response = new Readable({
		read() {
			this.push("Hello, world!");
			this.push(null);
		}
	});

	response.statusCode = 200;
	response.headers = {};
	response.trailers = {};
	response.socket = null;
	response.aborted = false;
	response.complete = true;
	response.httpVersion = '1.1';
	response.httpVersionMinor = 1;
	response.httpVersionMajor = 1;

	return response;
};

const instance = got.extend({
	request: (url, options, callback) => {
		return getCachedResponse(url, options);
	}
});

const body = await instance('https://example.com').text();

console.log(body);
//=> "Hello, world!"
```

If you don't want to alter the `request` function, you can return a cached response in a `beforeRequest` hook:

```js
import https from 'https';
import {Readable} from 'stream';
import got from 'got';

const getCachedResponse = (url, options) => {
	const response = new Readable({
		read() {
			this.push("Hello, world!");
			this.push(null);
		}
	});

	response.statusCode = 200;
	response.headers = {};
	response.trailers = {};
	response.socket = null;
	response.aborted = false;
	response.complete = true;
	response.httpVersion = '1.1';
	response.httpVersionMinor = 1;
	response.httpVersionMajor = 1;

	return response;
};

const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				return getCachedResponse(options.url, options);
			}
		]
	}
});

const body = await instance('https://example.com').text();

console.log(body);
//=> "Hello, world!"
```

If you want to prevent duplicating the same requests, you can use a handler instead.

```js
import got from 'got';

const map = new Map();

const instance = got.extend({
	handlers: [
		(options, next) => {
			if (options.isStream) {
				return next(options);
			}

			const pending = map.get(options.url.href);
			if (pending) {
				return pending;
			}

			const promise = next(options);

			map.set(options.url.href, promise);
			promise.finally(() => {
				map.delete(options.url.href);
			});

			return promise;
		}
	]
});

const [first, second] = await Promise.all([
	instance('https://httpbin.org/anything'),
	instance('https://httpbin.org/anything')
]);

console.log(first === second);
//=> true
```
