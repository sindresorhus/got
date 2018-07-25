'use strict';
const pkg = require('../package.json');
const create = require('./create');

const defaults = {
	methods: [
		'get',
		'post',
		'put',
		'patch',
		'head',
		'delete'
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
		useElectronNet: false,
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
