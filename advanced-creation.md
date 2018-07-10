# Advanced creation

> Make calling REST APIs easier by creating niche-specific `got` instances.

#### got.create(settings)

Example: [gh-got](https://github.com/sindresorhus/gh-got/blob/master/index.js)

Configure a new `got` instance with the provided settings.<br>
**Note:** In contrast to `got.extend()`, this method has no defaults.

##### [options](readme.md#options)

To inherit from parent, set it as `got.defaults.options` or use `got.assignOptions(defaults, options)`.<br>
You should avoid using [object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#Spread_in_object_literals) to merge options, as it may give unwanted result.

##### methods

Type: `Object`

Array of supported request methods.

To inherit from parent, set it as `got.defaults.methods`.

##### handler

Type: `Function`<br>
Default: `undefined`

Function making additional changes to the request.

To inherit from parent, set it as `got.defaults.handler`.<br>
To use the default handler, just omit specifying this.

###### [url](readme.md#url)

###### [options](readme.md#options)

###### next()

Normalizes arguments and returns a `Promise` or a `Stream` depending on [`options.stream`](readme.md#stream).

```js
const settings = {
	handler: (url, options, next) => {
		if (options.stream) {
			// It's a Stream
			// We can perform stream-specific actions on it
			return next(url, options)
				.on('request', request => setTimeout(() => request.abort(), 50));
		}

		// It's a Promise
		return next(url, options);
	},
	methods: got.defaults.methods,
	options: got.assignOptions(got.defaults.options, {
		json: true
	})
};

const jsonGot = got.create(settings);
```

```js
const defaults = {
	handler: (url, options, next) => {
		return next(url, options);
	},
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
	options: got.assignOptions(got.defaults.options, headers: {
		unicorn: 'rainbow'
	})
};

const unicorn = got.create(settings);

// Same as:
const unicorn = got.extend({headers: {unicorn: 'rainbow'}});
```

### Merging instances

You can merge 2 `got` instances into a single one:

```js
const is = require('@sindresorhus/is');

const instanceA = got.extend({headers: {dog: 'woof'}});
const instanceB = got.extend({headers: {cat: 'meow'}});

const simpleMerge = (a, b) => got.create({
	methods: a.defaults.methods,
	options: got.assignOptions(a.defaults.options, b.defaults.options),
	handler: (url, options, next) => a.defaults.handler(url, options, (url, options) => b.defaults.handler(url, options, next))
});

const merged = simpleMerge(instanceA, instanceB);
```

If you want to merge many instances, you can create a wrapper for that:

```js
const instanceA = got.extend({headers: {dog: 'woof'}});
const instanceB = got.extend({headers: {cat: 'meow'}});
const instanceC = got.extend({headers: {bird: 'tweet'}});

function merge() {
	const args = [...arguments];
	const len = args.length - 1;
	let iteration = 0;
	let lastNext;

	const handler = (url, options, next) => {
		if (iteration === len) {
			return args[iteration].defaults.handler(url, options, lastNext);
		}

		return args[iteration++].defaults.handler(url, options, handler);
	};

	const assignManyOpts = (options, iteration) => {
		if (iteration === len) {
			return options;
		}

		return assignManyOpts(got.assignOptions(options, args[++iteration].defaults.options), iteration);
	};

	return got.create({
		methods: args[0].defaults.methods,
		options: assignManyOpts(args[0].defaults.options, 0),
		handler: (url, options, next) => {
			lastNext = next;
			return handler(url, options);
		}
	});
}

const merged = merge(instanceA, instanceB, instanceC);

(async () => {
	const {headers} = (await merged('httpbin.org/headers', {json: true})).body;
	console.log(headers);

	// =>
	// { Accept: 'application/json',
	//   'Accept-Encoding': 'gzip, deflate',
	//   Bird: 'tweet',
	//   Cat: 'meow',
	//   Connection: 'close',
	//   Dog: 'woof',
	//   Host: 'httpbin.org',
	//   'User-Agent': 'got/8.3.1 (https://github.com/sindresorhus/got)' }
})();
```
