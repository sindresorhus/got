const got = require('./dist/source').default;

const instance = got.extend({
	handlers: [
		(options, next) => {
			if (options.isStream) {
				return next(options);
			}

			const promise = next(options);
			promise.getLength = async () => {
				return (await promise).body.length;
			};

			return promise;
		}
	]
});

(async () => {
	const response = await instance('https://httpbin.org/anything').getLength();
	console.log(response);
})();
