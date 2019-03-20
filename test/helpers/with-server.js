'use strict';
const {URL} = require('url');
const createTestServer = require('create-test-server');

exports.withServer = async (t, run) => {
	const s = await createTestServer();

	s.hostname = (new URL(s.url)).hostname;

	try {
		await run(t, s);
	} finally {
		await s.close();
	}
};
