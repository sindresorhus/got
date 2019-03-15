'use strict';
const {URL} = require('url');
const createTestServer = require('create-test-server');

exports.withServer = async (t, run) => {
	const s = await createTestServer();

	s.host = (new URL(s.url)).host;

	try {
		await run(t, s);
	} finally {
		await s.close();
	}
};
