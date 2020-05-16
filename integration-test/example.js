const got = require('../dist/source');

(async () => {
	try {
		await got('https://httpstat.us/500');
	} catch {
		process.exit(1); // eslint-disable-line unicorn/no-process-exit
	}
})();
