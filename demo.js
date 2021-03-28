const got = require('./dist/source').default;

(async () => {
	const response = await got('https://httpbin.org/anything');
	console.log(response.body);
})();
