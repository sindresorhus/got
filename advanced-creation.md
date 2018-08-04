# Advanced creation

> Make calling REST APIs easier by creating niche-specific `got` instances.

#### got.create(settings)

Example: [gh-got](https://github.com/sindresorhus/gh-got/blob/master/index.js)

Configure a new `got` instance with the provided settings.<br>
**Note:** In contrast to `got.extend()`, this method has no defaults.

##### [options](readme.md#options)

To inherit from parent, set it as `got.defaults.options` or use [`got.mergeOptions(defaults.options, options)`](readme.md#gotmergeoptionsparentoptions-newoptions).<br>
**Note**: Avoid using [object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#Spread_in_object_literals) as it doesn't work recursively.

##### methods

Type: `Object`

An array of supported request methods.

To inherit from parent, set it as `got.defaults.methods`.

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
	methods: got.defaults.methods,
	options: got.mergeOptions(got.defaults.options, {
		json: true
	})
};

const jsonGot = got.create(settings);
```

```js
const defaults = {
	handler: (options, next) => next(options),
	methods: [
		'get',
		'post',
		'put',
		'patch',
		'head',
		'delete'
	],
	options: {
		retries: 2,
		cache: false,
		decompress: true,
		useElectronNet: false,
		throwHttpErrors: true,
		headers: {
			'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
		}
	}
};

// Same as:
const defaults = {
	handler: got.defaults.handler,
	methods: got.defaults.methods,
	options: got.defaults.options
};

const unchangedGot = got.create(defaults);
```

```js
const settings = {
	handler: got.defaults.handler,
	methods: got.defaults.methods,
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
