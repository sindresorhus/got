import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';
import {DetailedPeerCertificate} from 'tls';
import pEvent from 'p-event';

test('https request without ca', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.truthy((await got.secure({
		https: {
			rejectUnauthorized: false
		}
	})).body);
});

test('https request with ca', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got.secure({
		https: {
			certificateAuthority: server.caCert
		},
		headers: {host: 'example.com'}
	});

	t.is(body, 'ok');
});

test('https request with `checkServerIdentity` OK', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got.secure({
		https: {
			certificateAuthority: server.caCert,
			checkServerIdentity: (hostname: string, certificate: DetailedPeerCertificate) => {
				t.is(hostname, 'example.com');
				t.is(certificate.subject.CN, 'example.com');
				t.is(certificate.issuer.CN, 'localhost');
			}
		},
		headers: {host: 'example.com'}
	});

	t.is(body, 'ok');
});

test('https request with `checkServerIdentity` NOT OK', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const promise = got.secure({
		https: {
			certificateAuthority: server.caCert,
			checkServerIdentity: (hostname: string, certificate: DetailedPeerCertificate) => {
				t.is(hostname, 'example.com');
				t.is(certificate.subject.CN, 'example.com');
				t.is(certificate.issuer.CN, 'localhost');

				return new Error('CUSTOM_ERROR');
			}
		},
		headers: {host: 'example.com'}
	});

	await t.throwsAsync(
		promise,
		{
			message: 'CUSTOM_ERROR'
		}
	);
});

test('https request with expired certificate', async t => {
	await t.throwsAsync(
		got('https://expired.badssl.com/'),
		{
			code: 'CERT_HAS_EXPIRED'
		}
	);
});

test('https request with wrong host', async t => {
	await t.throwsAsync(
		got('https://wrong.host.badssl.com/'),
		{
			code: 'ERR_TLS_CERT_ALTNAME_INVALID'
		}
	);
});

test('http2', async t => {
	const promise = got('https://httpbin.org/anything', {
		http2: true
	});

	const {headers, body} = await promise;
	await promise.json();

	// @ts-ignore Pseudo headers may not be strings
	t.is(headers[':status'], 200);
	t.is(typeof body, 'string');
});

test.serial('deprecated `rejectUnauthorized` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await new Promise(resolve => {
		(async () => {
			const warning = await pEvent(process, 'warning');
			t.is(warning.name, 'DeprecationWarning');
			resolve();
		})();

		(async () => {
			await got.secure({
				rejectUnauthorized: false
			});

			t.fail();
			resolve();
		})();
	});
});

test.serial('non-deprecated `rejectUnauthorized` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	(async () => {
		const warning = await pEvent(process, 'warning');
		t.not(warning.name, 'DeprecationWarning');
	})();

	await got.secure({
		https: {
			rejectUnauthorized: false
		}
	});

	t.pass();
});

test.serial('no double deprecated warning', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	(async () => {
		const warning = await pEvent(process, 'warning');
		t.is(warning.name, 'DeprecationWarning');
	})();

	await got.secure({
		rejectUnauthorized: false
	});

	(async () => {
		const warning = await pEvent(process, 'warning');
		t.not(warning.name, 'DeprecationWarning');
	})();

	await got.secure({
		rejectUnauthorized: false
	});

	t.pass();
});
