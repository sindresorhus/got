[> Back to homepage](../readme.md#documentation)

## Pagination API

Source code: [`source/create.ts`](../source/create.ts)

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
			return {url: next.reference};
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

A function that transform [`Response`](3-streams.md#response-1) into an array of items.\
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

#### `filter`

**Type: `Function`**\
**Default: `({item, currentItems, allItems}) => true`**

Whether the item should be emitted or not.

#### `shouldContinue`

**Type: `Function`**\
**Default: `({item, currentItems, allItems}) => true`**

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
