const got = require('../dist/source');

(async () => {
	try {
		await got('https://google.com');
		console.log('Integration test success');
	} catch {
		console.log('Integration test fail');
		process.exit(1); // eslint-disable-line unicorn/no-process-exit
	}
})();
