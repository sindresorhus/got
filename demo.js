const {got, Options} = require('.');

const o = new Options('asdf', {
	prefixUrl: 'https://example.com'
});

o.prefixUrl = 'https://cats.com';

console.log(o.url);

const instance = got.extend({
	handlers: [
		(options, next) => {
			if (options.isStream) {
				return next(options);
			}

			return (async () => {
				const result = await next(options);

				return result;
			})();
		}
	]
});

const promise = instance('https://httpbin.org/anything');
promise.catch(console.error);
promise.cancel();
