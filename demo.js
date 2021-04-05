const {got, Options} = require('./dist/source');

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
	// const response = await instance('https://httpbin.org/anything').getLength();
	// console.log(response);

	const o = new Options({
		prefixUrl: 'https://127.0.0.1',
		url: 'asdf'
	});

	console.log(o.prefixUrl);

	o.merge({
		prefixUrl: ''
	});

	console.log(o.url);
})();
