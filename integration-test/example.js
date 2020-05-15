const got = require('../dist/source');

(async () => {
	try {
		await got('https://google.com');
	} catch {
		process.exit(1); // eslint-disable-line unicorn/no-process-exit
	}
})();
