const {got} = require('.');

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
