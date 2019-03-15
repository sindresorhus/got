'use strict';
const createTestServer = require('create-test-server');

exports.host = 'localhost';
const {host} = exports;

exports.withServer = async (t, run) => {
	const s = await createTestServer();

	s.host = host;

	try {
		await run(t, s);
	} finally {
		await s.close();
	}
};
