import test from 'ava';
import tls, {DetailedPeerCertificate} from 'tls';
import pEvent from 'p-event';
import pify from 'pify';
import pem from 'pem';
import got from '../source/index.js';
import {withHttpsServer} from './helpers/with-server.js';

const createPrivateKey = pify(pem.createPrivateKey);
const createCSR = pify(pem.createCSR);
const createCertificate = pify(pem.createCertificate);
const createPkcs12 = pify(pem.createPkcs12);

test('https request without ca', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.truthy((await got({
		httpsOptions: {
			certificateAuthority: [],
			rejectUnauthorized: false
		}
	})).body);
});

test('https request with ca', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({});

	t.is(body, 'ok');
});

test('https request with ca and afterResponse hook', withHttpsServer(), async (t, server, got) => {
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
	const {body} = await got({
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

test('https request with `checkServerIdentity` OK', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({
		httpsOptions: {
			checkServerIdentity: (hostname: string, certificate: DetailedPeerCertificate) => {
				t.is(hostname, 'localhost');
				t.is(certificate.subject.CN, 'localhost');
				t.is(certificate.issuer.CN, 'authority');
			}
		}
	});

	t.is(body, 'ok');
});

test('https request with `checkServerIdentity` NOT OK', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const promise = got({
		httpsOptions: {
			checkServerIdentity: (hostname: string, certificate: DetailedPeerCertificate) => {
				t.is(hostname, 'localhost');
				t.is(certificate.subject.CN, 'localhost');
				t.is(certificate.issuer.CN, 'authority');

				return new Error('CUSTOM_ERROR');
			}
		}
	});

	await t.throwsAsync(
		promise,
		{
			message: 'CUSTOM_ERROR'
		}
	);
});

// The built-in `openssl` on macOS does not support negative days.
{
	const testFn = process.platform === 'darwin' ? test.skip : test;
	testFn('https request with expired certificate', withHttpsServer({days: -1}), async (t, _server, got) => {
		await t.throwsAsync(
			got({}),
			{
				code: 'CERT_HAS_EXPIRED'
			}
		);
	});
}

test('https request with wrong host', withHttpsServer({commonName: 'not-localhost.com'}), async (t, _server, got) => {
	await t.throwsAsync(
		got({}),
		{
			code: 'ERR_TLS_CERT_ALTNAME_INVALID'
		}
	);
});

test('http2', async t => {
	const promise = got('https://httpbin.org/anything', {
		http2: true
	});

	try {
		const {headers, body} = await promise;
		await promise.json();

		// @ts-expect-error Pseudo headers may not be strings
		t.is(headers[':status'], 200);
		t.is(typeof body, 'string');

		t.pass();
	} catch (error) {
		if (error.message.includes('install Node.js')) {
			t.pass();

			return;
		}

		t.fail(error.stack);
	}
});

test.serial('deprecated `rejectUnauthorized` option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(got({
		// @ts-expect-error
		rejectUnauthorized: false
	}), {
		message: 'Unexpected option: rejectUnauthorized'
	});
});

test.serial('non-deprecated `rejectUnauthorized` option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	(async () => {
		const warning = await pEvent(process, 'warning');
		t.not(warning.name, 'DeprecationWarning');
	})();

	await got({
		httpsOptions: {
			rejectUnauthorized: false
		}
	});

	t.pass();
});

test('client certificate', withHttpsServer(), async (t, server, got) => {
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

	const response = await got({
		httpsOptions: {
			key: clientKey,
			certificate: clientCert
		}
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid client certificate (self-signed)', withHttpsServer(), async (t, server, got) => {
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

	const response = await got({
		httpsOptions: {
			key: clientKey,
			certificate: clientCert
		}
	}).json<{
		authorized: boolean;
	}>();

	t.is(response.authorized, false);
});

test('invalid client certificate (other CA)', withHttpsServer(), async (t, server, got) => {
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

	const response = await got({
		httpsOptions: {
			key: clientKey,
			certificate: clientCert
		}
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.false(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'other-client');
	t.is(response.peerCertificate.issuer.CN, 'other-authority');
});

test('key passphrase', withHttpsServer(), async (t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
		t.pass();
		return;
	}

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

	const response = await got({
		httpsOptions: {
			key: clientKey,
			passphrase: 'randomPassword',
			certificate: clientCert
		}
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid key passphrase', withHttpsServer(), async (t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
		t.pass();
		return;
	}

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

	const request = got({
		httpsOptions: {
			key: clientKey,
			passphrase: 'wrongPassword',
			certificate: clientCert
		}
	});

	await t.throwsAsync(request, {
		code: 'ERR_OSSL_EVP_BAD_DECRYPT'
	});
});

test('client certificate PFX', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate = undefined; // Circular structure

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

	const {pkcs12} = await createPkcs12(clientKey, clientCert, 'randomPassword');

	const response = await got({
		httpsOptions: {
			pfx: pkcs12,
			passphrase: 'randomPassword'
		}
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

const ciphers = tls.getCiphers().map(cipher => cipher.toUpperCase());

test('https request with `ciphers` option', withHttpsServer({ciphers: `${ciphers[0]!}:${ciphers[1]!}:${ciphers[2]!}`}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			cipher: (request.socket as any).getCipher().name
		});
	});

	const response = await got({
		httpsOptions: {
			ciphers: ciphers[0]
		}
	}).json<{cipher: string}>();

	t.is(response.cipher, ciphers[0]);
});

test('https request with `honorCipherOrder` option', withHttpsServer({ciphers: `${ciphers[0]!}:${ciphers[1]!}`}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			cipher: (request.socket as any).getCipher().name
		});
	});

	const response = await got({
		httpsOptions: {
			ciphers: `${ciphers[1]!}:${ciphers[0]!}`,
			honorCipherOrder: true
		}
	}).json<{cipher: string}>();

	t.is(response.cipher, ciphers[0]);
});

test('https request with `minVersion` option', withHttpsServer({maxVersion: 'TLSv1.2'}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			version: (request.socket as any).getCipher().version
		});
	});

	const request = got({
		httpsOptions: {
			minVersion: 'TLSv1.3'
		}
	});

	await t.throwsAsync(request, {
		code: 'EPROTO'
	});
});
