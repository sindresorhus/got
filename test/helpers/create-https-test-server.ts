import type http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import type {SecureContextOptions} from 'node:tls';
import express from 'express';
import pify from 'pify';
import pem from 'pem';
import type {CreateCsr, CreateCertificate} from '../types/pem.js';

export type HttpsServerOptions = {
	commonName?: string;
	days?: number;
	ciphers?: SecureContextOptions['ciphers'];
	honorCipherOrder?: SecureContextOptions['honorCipherOrder'];
	minVersion?: SecureContextOptions['minVersion'];
	maxVersion?: SecureContextOptions['maxVersion'];
};

export type ExtendedHttpsTestServer = {
	https: https.Server;
	caKey: Uint8Array;
	caCert: Uint8Array;
	url: string;
	port: number;
	close: () => Promise<void>;
} & express.Express;

const createHttpsTestServer = async (options: HttpsServerOptions = {}): Promise<ExtendedHttpsTestServer> => {
	const createCsr = pify(pem.createCSR as CreateCsr);
	const createCertificate = pify(pem.createCertificate as CreateCertificate);
	const commonName = options.commonName ?? 'localhost';
	const serverCertificateConfiguration = `
[req]
req_extensions = v3_req
[dn]
CN = ${commonName}
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = ${commonName}
`;
	const caCertificateConfiguration = `
[req]
req_extensions = v3_req
[dn]
CN = authority
[v3_req]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
`;

	const caCsrResult = await createCsr({commonName: 'authority'});
	const caResult = await createCertificate({
		csr: caCsrResult.csr,
		clientKey: caCsrResult.clientKey,
		selfSigned: true,
		config: caCertificateConfiguration,
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const serverCsrResult = await createCsr({commonName});
	const serverResult = await createCertificate({
		csr: serverCsrResult.csr,
		clientKey: serverCsrResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert,
		config: serverCertificateConfiguration,
		days: options.days ?? 365,
	});
	const serverKey = serverResult.clientKey;
	const serverCert = serverResult.certificate;

	const server = express() as ExtendedHttpsTestServer;
	server.https = https.createServer(
		{
			key: serverKey,
			cert: serverCert,
			ca: caCert,
			requestCert: true,
			rejectUnauthorized: false, // This should be checked by the test
			ciphers: options.ciphers,
			honorCipherOrder: options.honorCipherOrder,
			minVersion: options.minVersion,
			maxVersion: options.maxVersion,
		},
		server as unknown as http.RequestListener,
	);

	server.set('etag', false);

	await pify(server.https.listen.bind(server.https))();

	server.caKey = caKey as any;
	server.caCert = caCert;
	server.port = (server.https.address() as net.AddressInfo).port;
	server.url = `https://localhost:${server.port}`;

	server.close = async () => new Promise<void>((resolve, reject) => {
		server.https.closeAllConnections?.();
		server.https.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});

	return server;
};

export default createHttpsTestServer;
