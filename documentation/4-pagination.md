[> Back to homepage](../readme.md#documentation)

## Pagination API

Source code: [`source/create.ts`](../source/create.ts)

### How does the `Link` header work?

The [RFC5988](https://datatracker.ietf.org/doc/html/rfc5988#section-5) defines how the `Link` header looks like.

When the response has been processed, Got looks for [the reference of the `next` relation](https://datatracker.ietf.org/doc/html/rfc5988#section-6.2.2).\
This way Got knows the URL it should visit afterwards. The header can look like this:

```
Link: <https://api.github.com/repositories/18193978/commits?page=2>; rel="next", <https://api.github.com/repositories/18193978/commits?page=44>; rel="last"
```

By default, Got looks only at the `next` relation. To use [other relations](https://datatracker.ietf.org/doc/html/rfc5988#section-6.2.2), you need to customize the `paginate` function below.

### `got.paginate(url, options?)`
### `got.paginate.each(url, options?)`

Returns an [async iterator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of).

This is memory efficient, as the logic is executed immediately when new data comes in.

```js
import got from 'got';

const countLimit = 10;

const pagination = got.paginate(
	'https://api.github.com/repos/sindresorhus/got/commits',
	{
		pagination: {countLimit}
	}
);

console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);

for await (const commitData of pagination) {
	console.log(commitData.commit.message);
}
```

### `got.paginate.all(url, options?)`

**Note:**
> - Querying a large dataset significantly increases memory usage.

Returns a Promise for an array of all results.

```js
import got from 'got';

const countLimit = 10;

const results = await got.paginate.all('https://api.github.com/repos/sindresorhus/got/commits', {
	pagination: {countLimit}
});

console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);
console.log(results);
```

### `pagination`

**Type: `object`**\
**Default:**

```js
{
	transform: (response: Response) => {
		if (response.request.options.responseType === 'json') {
			return response.body;
		}

		return JSON.parse(response.body as string);
	},
	paginate: ({response}) => {
		const rawLinkHeader = response.headers.link;
		if (typeof rawLinkHeader !== 'string' || rawLinkHeader.trim() === '') {
			return false;
		}

		const parsed = parseLinkHeader(rawLinkHeader);
		const next = parsed.find(entry => entry.parameters.rel === 'next' || entry.parameters.rel === '"next"');

		if (next) {
			return {
				url: new URL(next.reference, response.requestUrl)
			};
		}

		return false;
	},
	filter: () => true,
	shouldContinue: () => true,
	countLimit: Number.POSITIVE_INFINITY,
	backoff: 0,
	requestLimit: 10_000,
	stackAllItems: false
}
```

This option represents the `pagination` object.

#### `transform`

**Type: `Function`**\
**Default: `response => JSON.parse(response.body)`**

A function that transforms [`Response`](3-streams.md#response-1) into an array of items.\
This is where you should do the parsing.

#### `paginate`

**Type: `Function`**\
**Default: `Link` header logic**

The function takes an object with the following properties:

- `response` - The current response object,
- `currentItems` - Items from the current response,
- `allItems` - An empty array, unless `stackAllItems` is `true`, otherwise it contains all emitted items.

It should return an object representing Got options pointing to the next page. If there is no next page, `false` should be returned instead.

The options are merged automatically with the previous request.\
Therefore the options returned by `pagination.paginate(…)` must reflect changes only.

**Note:**
> - The `url` option (if set) accepts **only** a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) instance.\
>   This prevents `prefixUrl` ambiguity. In order to use a relative URL string, merge it via `new URL(relativeUrl, response.url)`.

#### `filter`

**Type: `Function`**\
**Default: `({item, currentItems, allItems}) => true`**

Whether the item should be emitted or not.

#### `shouldContinue`

**Type: `Function`**\
**Default: `({item, currentItems, allItems}) => true`**

**Note:**
> - This function executes only when `filter` returns `true`.

For example, if you need to stop before emitting an entry with some flag, you should use `({item}) => !item.flag`.

If you want to stop after emitting the entry, you should use `({item, allItems}) => allItems.some(item => item.flag)` instead.

#### `countLimit`

**Type: `number`**\
**Default: `Number.POSITIVE_INFINITY`**

The maximum amount of items that should be emitted.

#### `backoff`

**Type: `number`**\
**Default: `0`**

Milliseconds to wait before the next request is triggered.

#### `requestLimit`

**Type: `number`**\
**Default: `10000`**

The maximum amount of request that should be triggered.

**Note:**
> - [Retries on failure](7-retry.md) are not counted towards this limit.

#### `stackAllItems`

**Type: `boolean`**\
**Default: `false`**

Defines how `allItems` is managed in `pagination.paginate`, `pagination.filter` and `pagination.shouldContinue`.

By default, `allItems` is always an empty array. Setting this to `true` will significantly increase memory usage when working with a large dataset.

### Example

In this example we will use `searchParams` instead of `Link` header.\
Just to show how you can customize the `paginate` function.

The reason `filter` looks exactly the same like `shouldContinue` is that the latter will tell Got to stop once we reach our timestamp.
The `filter` function is needed as well, because in the same response we can get results with different timestamps.

```js
import got from 'got';
import Bourne from '@hapi/bourne';

const max = Date.now() - 1000 * 86400 * 7;

const iterator = got.paginate('https://api.github.com/repos/sindresorhus/got/commits', {
	pagination: {
		paginate: ({response, currentItems}) => {
			// If there are no more data, finish.
			if (currentItems.length === 0) {
				return false;
			}

			// Get the current page number.
			const {searchParams} = response.request.options;
			const previousPage = Number(searchParams.get('page') ?? 1);

			// Update the page number by one.
			return {
				searchParams: {
					page: previousPage + 1
				}
			};
		},
		// Using `Bourne` to prevent prototype pollution.
		transform: response => Bourne.parse(response.body),
		filter: ({item}) => {
			// Check if the commit time exceeds our range.
			const date = new Date(item.commit.committer.date);
			const end = date.getTime() - max >= 0;

			return end;
		},
		shouldContinue: ({item}) => {
			// Check if the commit time exceeds our range.
			const date = new Date(item.commit.committer.date);
			const end = date.getTime() - max >= 0;

			return end;
		},
		// We want only 50 results.
		countLimit: 50,
		// Wait 1s before making another request to prevent API rate limiting.
		backoff: 1000,
		// It is a good practice to set an upper limit of how many requests can be made.
		// This way we can avoid infinite loops.
		requestLimit: 10,
		// In this case, we don't need to store all the items we receive.
		// They are processed immediately.
		stackAllItems: false
	}
});

console.log('Last 50 commits from now to week ago:');
for await (const item of iterator) {
	console.log(item.commit.message.split('\n')[0]);
}
```
