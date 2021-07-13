[> Back to homepage](../readme.md#documentation)

## Let's make a plugin!

> Another example on how to use Got like a boss :electric_plug:

Okay, so you already have learned some basics. That's great!

When it comes to advanced usage, custom instances are really helpful.
For example, take a look at [`gh-got`](https://github.com/sindresorhus/gh-got).
It looks pretty complicated, but... it's simple and extremely useful.

Before we start, we need to find the [GitHub API docs](https://developer.github.com/v3/).

Let's write down the most important information:
1. The root endpoint is `https://api.github.com/`.
2. We will use version 3 of the API.\
   The `Accept` header needs to be set to `application/vnd.github.v3+json`.
3. The body is in a JSON format.
4. We will use OAuth2 for authorization.
5. We may receive `400 Bad Request` or `422 Unprocessable Entity`.\
   The body contains detailed information about the error.
6. *Pagination?* Yeah! Supported natively by Got.
7. Rate limiting. These headers are interesting:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

Also `X-GitHub-Request-Id` may be useful for debugging.

8. The `User-Agent` header is required.

When we have all the necessary info, we can start mixing :cake:

### The root endpoint

Not much to do here. Just extend an instance and provide the `prefixUrl` option:

```js
import got from 'got';

const instance = got.extend({
	prefixUrl: 'https://api.github.com'
});

export default instance;
```

### v3 API

GitHub needs to know which API version we are using. We'll use the `Accept` header for that:

```js
import got from 'got';

const instance = got.extend({
	prefixUrl: 'https://api.github.com',
	headers: {
		accept: 'application/vnd.github.v3+json'
	}
});

export default instance;
```

### JSON body

We'll use [`options.responseType`](2-options.md#responsetype):

```js
import got from 'got';

const instance = got.extend({
	prefixUrl: 'https://api.github.com',
	headers: {
		accept: 'application/vnd.github.v3+json'
	},
	responseType: 'json'
});

export default instance;
```

### Authorization

It's common to set some environment variables, for example, `GITHUB_TOKEN`. You can modify the tokens in all your apps easily, right? Cool. What about... we want to provide a unique token for each app. Then we will need to create a new option - it will default to the environment variable, but you can easily override it.

Got performs option validation and doesn't know that `token` is a wanted option so it will throw. We can handle it inside an `init` hook and save it in `options.context`.

```js
import got from 'got';

const instance = got.extend({
	prefixUrl: 'https://api.github.com',
	headers: {
		accept: 'application/vnd.github.v3+json'
	},
	responseType: 'json',
	context: {
		token: process.env.GITHUB_TOKEN,
	},
	hooks: {
		init: [
			(raw, options) => {
				if ('token' in raw) {
					options.context.token = raw.token;
					delete raw.token;
				}
			}
		]
	}
});

export default instance;
```

For the rest we will use a handler. We could use hooks, but this way it will be more readable. Having `beforeRequest`, `beforeError` and `afterResponse` hooks for just a few lines of code would complicate things unnecessarily.

**Tip:**
> - It's a good practice to use hooks when your plugin gets complicated.
> - Try not to overload the handler function, but don't abuse hooks either.

```js
import got from 'got';

const instance = got.extend({
	prefixUrl: 'https://api.github.com',
	headers: {
		accept: 'application/vnd.github.v3+json'
	},
	responseType: 'json',
	context: {
		token: process.env.GITHUB_TOKEN,
	},
	hooks: {
		init: [
			(raw, options) => {
				if ('token' in raw) {
					options.context.token = raw.token;
					delete raw.token;
				}
			}
		]
	},
	handlers: [
		(options, next) => {
			// Authorization
			const {token} = options.context;
			if (token && !options.headers.authorization) {
				options.headers.authorization = `token ${token}`;
			}

			return next(options);
		}
	]
});

export default instance;
```

### Errors

We should name our errors, just to know if the error is from the API response. Superb errors, here we come!

```js
...
	handlers: [
		(options, next) => {
			// Authorization
			const {token} = options.context;
			if (token && !options.headers.authorization) {
				options.headers.authorization = `token ${token}`;
			}

			// Don't touch streams
			if (options.isStream) {
				return next(options);
			}

			// Magic begins
			return (async () => {
				try {
					const response = await next(options);

					return response;
				} catch (error) {
					const {response} = error;

					// Nicer errors
					if (response && response.body) {
						error.name = 'GitHubError';
						error.message = `${response.body.message} (${response.statusCode} status code)`;
					}

					throw error;
				}
			})();
		}
	]
...
```

Note that by providing our own errors in handlers, we don't alter the ones in `beforeError` hooks.\
The conversion is the last thing here.

### Rate limiting

Umm... `response.headers['x-ratelimit-remaining']` doesn't look good. What about `response.rateLimit.limit` instead?\
Yeah, definitely. Since `response.headers` is an object, we can easily parse these:

```js
const getRateLimit = (headers) => ({
	limit: Number.parseInt(headers['x-ratelimit-limit'], 10),
	remaining: Number.parseInt(headers['x-ratelimit-remaining'], 10),
	reset: new Date(Number.parseInt(headers['x-ratelimit-reset'], 10) * 1000)
});

getRateLimit({
	'x-ratelimit-limit': '60',
	'x-ratelimit-remaining': '55',
	'x-ratelimit-reset': '1562852139'
});
// => {
// 	limit: 60,
// 	remaining: 55,
// 	reset: 2019-07-11T13:35:39.000Z
// }
```

Let's integrate it:

```js
const getRateLimit = (headers) => ({
	limit: Number.parseInt(headers['x-ratelimit-limit'], 10),
	remaining: Number.parseInt(headers['x-ratelimit-remaining'], 10),
	reset: new Date(Number.parseInt(headers['x-ratelimit-reset'], 10) * 1000)
});

...
	handlers: [
		(options, next) => {
			// Authorization
			const {token} = options.context;
			if (token && !options.headers.authorization) {
				options.headers.authorization = `token ${token}`;
			}

			// Don't touch streams
			if (options.isStream) {
				return next(options);
			}

			// Magic begins
			return (async () => {
				try {
					const response = await next(options);

					// Rate limit for the Response object
					response.rateLimit = getRateLimit(response.headers);

					return response;
				} catch (error) {
					const {response} = error;

					// Nicer errors
					if (response && response.body) {
						error.name = 'GitHubError';
						error.message = `${response.body.message} (${response.statusCode} status code)`;
					}

					// Rate limit for errors
					if (response) {
						error.rateLimit = getRateLimit(response.headers);
					}

					throw error;
				}
			})();
		}
	]
...
```

### The frosting on the cake: `User-Agent` header.

```js
const packageJson = {
	name: 'gh-got',
	version: '12.0.0'
};

const instance = got.extend({
	...
	headers: {
		accept: 'application/vnd.github.v3+json',
		'user-agent': `${packageJson.name}/${packageJson.version}`
	},
	...
});
```

## Woah. Is that it?

Yup. View the full source code [here](examples/gh-got.js). Here's an example of how to use it:

```js
import ghGot from 'gh-got';

const response = await ghGot('users/sindresorhus');
const creationDate = new Date(response.created_at);

console.log(`Sindre's GitHub profile was created on ${creationDate.toGMTString()}`);
// => Sindre's GitHub profile was created on Sun, 20 Dec 2009 22:57:02 GMT
```

### Pagination

```js
import ghGot from 'gh-got';

const countLimit = 50;
const pagination = ghGot.paginate(
	'repos/sindresorhus/got/commits',
	{
		pagination: {countLimit}
	}
);

console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);

for await (const commitData of pagination) {
	console.log(commitData.commit.message);
}
```

That's... astonishing! We don't have to implement pagination on our own. Got handles it all.

### At the end

Did you know you can mix many instances into a bigger, more powerful one? Check out the [Advanced Creation](examples/advanced-creation.js) guide.
