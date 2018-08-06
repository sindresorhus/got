'use strict';
const pkg = require('../package.json');
const create = require('./create');

const defaults = {
	methods: [
		'GET',
		'POST',
		'PUT',
		'PATCH',
		'HEAD',
		'DELETE'
	],
	options: {
		retry: {
			retries: 2,
			methods: [
				'GET',
				'PUT',
				'HEAD',
				'DELETE',
				'OPTIONS',
				'TRACE'
			],
			statusCodes: [
				408,
				413,
				429,
				502,
				503,
				504
			]
		},
		cache: false,
		decompress: true,
		throwHttpErrors: true,
		headers: {
			'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
		},
		hooks: {
			beforeRequest: []
		}
	}
};

const got = create(defaults);

module.exports = got;
