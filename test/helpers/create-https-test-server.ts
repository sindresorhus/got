import * as https from 'https';
import * as net from 'net';
import * as express from 'express';
import * as pify from 'pify';
import * as pem from 'pem';

export type HttpsServerOptions = {
	commonName?: string;
	days?: number;
};

export interface ExtendedHttpsTestServer extends express.Express {
	https: https.Server;
	caKey: Buffer;
	caCert: Buffer;
	url: string;
	port: number;
	close: () => Promise<any>;
}

const createHttpsTestServer = async (options: HttpsServerOptions = {}): Promise<ExtendedHttpsTestServer> => {
	const createCSR = pify(pem.createCSR);
	const createCertificate = pify(pem.createCertificate);

	const caCSRResult = await createCSR({commonName: 'authority'});
	const caResult = await createCertificate({
		csr: caCSRResult.csr,
		clientKey: caCSRResult.clientKey,
		selfSigned: true
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const serverCSRResult = await createCSR({commonName: options.commonName ?? 'localhost'});
	const serverResult = await createCertificate({
		csr: serverCSRResult.csr,
		clientKey: serverCSRResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert,
		days: options.days ?? 365
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
			rejectUnauthorized: false // This should be checked by the test
		},
		server
	);

	server.set('etag', false);

	await pify(server.https.listen.bind(server.https))();

	server.caKey = caKey;
	server.caCert = caCert;
	server.port = (server.https.address() as net.AddressInfo).port;
	server.url = `https://localhost:${(server.port)}`;

	server.close = async () => pify(server.https.close.bind(server.https))();

	return server;
};

export default createHttpsTestServer;
