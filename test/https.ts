import test from 'ava';
import got, {CancelableRequest} from '../source';
import withServer, {withCertServer} from './helpers/with-server';
import {DetailedPeerCertificate} from 'tls';
import pEvent from 'p-event';
import pify = require('pify');
import pem = require('pem');

const createPrivateKey = pify(pem.createPrivateKey);
const createCSR = pify(pem.createCSR);
const createCertificate = pify(pem.createCertificate);

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

test('https request with ca and afterResponse hook', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const warningListener = (warning: any) => {
		if (
			warning.name === 'DeprecationWarning' &&
			warning.message === 'Got: "options.ca" was never documented, please use ' +
				'"options.https.certificateAuthority"'
		) {
			process.off('warning', warningListener);
			t.fail('unexpected deprecation warning');
		}
	};

	process.once('warning', warningListener);

	let shouldRetry = true;
	const {body} = await got.secure({
		https: {
			certificateAuthority: server.caCert
		},
		headers: {host: 'example.com'},
		hooks: {
			afterResponse: [
				(response, retry) => {
					if (shouldRetry) {
						shouldRetry = false;

						return retry({});
					}

					return response;
				}
			]
		}
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

	// @ts-expect-error Pseudo headers may not be strings
	t.is(headers[':status'], 200);
	t.is(typeof body, 'string');
});

test.serial('deprecated `rejectUnauthorized` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await new Promise(resolve => {
		let request: CancelableRequest;
		(async () => {
			const warning = await pEvent(process, 'warning');
			t.is(warning.name, 'DeprecationWarning');
			request!.cancel();
			resolve();
		})();

		(async () => {
			request = got.secure({
				rejectUnauthorized: false
			});

			try {
				await request;
				t.fail();
			} catch {
				t.true(request!.isCanceled);
			}

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

test('client certificate', withCertServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate
		});
	});

	const clientCSRResult = await createCSR({commonName: 'client'});
	const clientResult = await createCertificate({
		csr: clientCSRResult.csr,
		clientKey: clientCSRResult.clientKey,
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response: any = await got.secure({
		https: {
			key: clientKey,
			certificate: clientCert
		}
	}).json();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid client certificate (self-signed)', withCertServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate
		});
	});

	const clientCSRResult = await createCSR({commonName: 'other-client'});
	const clientResult = await createCertificate({
		csr: clientCSRResult.csr,
		clientKey: clientCSRResult.clientKey,
		selfSigned: true
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response: any = await got.secure({
		https: {
			key: clientKey,
			certificate: clientCert
		}
	}).json();

	t.is(response.authorized, false);
});

test('invalid client certificate (other CA)', withCertServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate
		});
	});

	const caCSRResult = await createCSR({commonName: 'other-authority'});
	const caResult = await createCertificate({
		csr: caCSRResult.csr,
		clientKey: caCSRResult.clientKey,
		selfSigned: true
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const clientCSRResult = await createCSR({commonName: 'other-client'});
	const clientResult = await createCertificate({
		csr: clientCSRResult.csr,
		clientKey: clientCSRResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response: any = await got.secure({
		https: {
			key: clientKey,
			certificate: clientCert
		}
	}).json();

	t.false(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'other-client');
	t.is(response.peerCertificate.issuer.CN, 'other-authority');
});

test('key passphrase', withCertServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate
		});
	});

	const {key: clientKey} = await createPrivateKey(2048, {
		cipher: 'aes256',
		password: 'randomPassword'
	});
	const clientCSRResult = await createCSR({
		// eslint-disable-next-line object-shorthand
		clientKey: clientKey,
		clientKeyPassword: 'randomPassword',
		commonName: 'client'
	});
	const clientResult = await createCertificate({
		csr: clientCSRResult.csr,
		clientKey: clientCSRResult.clientKey,
		clientKeyPassword: 'randomPassword',
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert
	});
	const clientCert = clientResult.certificate;

	const response: any = await got.secure({
		https: {
			key: clientKey,
			passphrase: 'randomPassword',
			certificate: clientCert
		}
	}).json();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid key passphrase', withCertServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate
		});
	});

	const {key: clientKey} = await createPrivateKey(2048, {
		cipher: 'aes256',
		password: 'randomPassword'
	});
	const clientCSRResult = await createCSR({
		// eslint-disable-next-line object-shorthand
		clientKey: clientKey,
		clientKeyPassword: 'randomPassword',
		commonName: 'client'
	});
	const clientResult = await createCertificate({
		csr: clientCSRResult.csr,
		clientKey: clientCSRResult.clientKey,
		clientKeyPassword: 'randomPassword',
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert
	});
	const clientCert = clientResult.certificate;

	const NODE_10 = process.versions.node.split('.')[0] === '10';

	const request = got.secure({
		https: {
			key: clientKey,
			passphrase: 'wrongPassword',
			certificate: clientCert
		}
	});

	// Node.JS 10 does not have an error code, it only has a mesage
	if (NODE_10) {
		try {
			await request;
		} catch (error) {
			t.true((error.message as string).includes('bad decrypt'));
		}
	} else {
		await t.throwsAsync(request, {
			code: 'ERR_OSSL_EVP_BAD_DECRYPT'
		});
	}
});
